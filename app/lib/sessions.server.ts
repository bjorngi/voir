import {
  AcpClient,
  HttpJsonRpcTransport,
  type SessionUpdate,
} from "./acp-client.server";
import { capture as captureTimeline } from "./timeline.server";
import type {
  AvailableModel,
  AvailableMode,
  ChatMessage,
  ContentBlock,
  ControlUpdate,
  FolderSummary,
  SessionSummary,
  SlashCommand,
} from "./chat-types";

/**
 * Server-side session manager.
 *
 * Two-level model:
 *
 *   Folder  (== one running ACP agent, == one sandbox boundary)
 *     └─ Session  (== one conversation thread inside that folder)
 *
 * Voir does NOT spawn agents. An external launcher (see
 * `bin/acp-spawn`) starts the agent in a worktree, exposes it as an
 * HTTP JSON-RPC 2.0 endpoint, and registers it via
 *   POST /api/folders
 * Teardown is `DELETE /api/folders`; Voir also heartbeats the
 * endpoint every 10s.
 *
 * Everything agent → UI is fanned out as `ChatMessage`s over SSE.
 * Everything UI → agent goes through normal session/ methods.
 */

const HEARTBEAT_TIMEOUT_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

class SessionManager {
  private folders = new Map<string, FolderState>();
  private clients = new Map<string, AcpClient>();
  private listeners = new Map<string, Set<SessionListener>>();
  private turnWaiters = new Map<string, TurnWaiter>();
  private heartbeats = new Map<string, NodeJS.Timeout>();
  /** Folders with a resync currently in flight (guards overlap). */
  private resyncInFlight = new Set<string>();

  // -----------------------------------------------------------------------
  // Folder lifecycle
  // -----------------------------------------------------------------------

  async registerFolder(opts: {
    path: string;
    agentUrl: string;
    agentName?: string;
  }): Promise<FolderState> {
    const path = normalizeFolder(opts.path);
    const existing = this.folders.get(path);

    // Idempotent re-registration. The launcher (bin/acp-spawn)
    // re-registers periodically so a Voir restart self-heals;
    // same endpoint means nothing to rebuild — just refresh the
    // label, the liveness bookkeeping, and the heartbeat.
    if (existing && existing.agentUrl === opts.agentUrl) {
      if (opts.agentName !== undefined) existing.agentName = opts.agentName;
      // A successful registration POST is itself proof of life.
      existing.lastSeenAt = Date.now();
      if (existing.status === "degraded") existing.status = "ok";
      this.startHeartbeat(path);
      return existing;
    }

    // New folder, or the same folder under a new agentUrl (the
    // launcher restarted and picked a new port): build a fresh
    // client. Sessions are kept — the agent persists them on
    // disk and the session ids survive launcher restarts.
    const client = new AcpClient({
      label: opts.agentName ?? path,
      transport: () => new HttpJsonRpcTransport(opts.agentUrl),
    });
    this.attachClientNotifications(path, client);
    await client.start();

    if (existing) {
      const old = this.clients.get(path);
      if (old) {
        try {
          await old.stop();
        } catch {}
      }
      this.clients.set(path, client);
      existing.agentUrl = opts.agentUrl;
      if (opts.agentName !== undefined) existing.agentName = opts.agentName;
      // client.start() completed the initialize handshake: the
      // agent answered, so it is alive.
      existing.lastSeenAt = Date.now();
      existing.status = "ok";
      this.startHeartbeat(path);
      return existing;
    }

    const state: FolderState = {
      path,
      agentUrl: opts.agentUrl,
      agentName: opts.agentName,
      registeredAt: Date.now(),
      status: "ok",
      lastSeenAt: Date.now(),
      sessions: new Map(),
      activeSessionId: null,
      availableCommands: [],
      availableModels: [],
      availableModes: [],
      currentModeId: null,
      currentModelId: null,
    };
    this.folders.set(path, state);
    this.clients.set(path, client);

    this.startHeartbeat(path);
    return state;
  }

  /**
   * Wire a client's JSON-RPC notifications into the session
   * manager's dispatch. Shared by the new-folder and
   * re-registration paths in registerFolder.
   */
  private attachClientNotifications(path: string, client: AcpClient) {
    client.onNotification((method, params) => {
      const p = params as { sessionId?: string; update?: SessionUpdate } | undefined;
      // All session-scoped notifications from pi-acp arrive
      // wrapped in a `session/update` JSON-RPC notification. The
      // actual update kind is in `params.update.sessionUpdate`.
      // We dispatch on that inner field rather than the outer
      // `method` so we cover `available_commands_update`,
      // `current_mode_update`, `current_model_update`, etc. in
      // the same code path as agent chunks and tool calls.
      if (method === "session/update" && p?.sessionId && p.update) {
        this.handleSessionUpdate(p.sessionId, p.update);
        return;
      }
      // Folder-scoped notifications (no sessionId) are rare in
      // practice; keep the explicit matchers as a defensive
      // fallback in case an agent publishes a top-level
      // notification that doesn't go through session/update.
      if (method === "current_mode_update") {
        const modeId = (params as { currentModeId: string }).currentModeId;
        if (typeof modeId === "string") this.handleModeUpdate(path, modeId);
      } else if (method === "current_model_update") {
        const modelId = (params as { currentModelId: string }).currentModelId;
        if (typeof modelId === "string") this.handleModelUpdate(path, modelId);
      } else if (method === "available_commands_update") {
        const cmds = (params as { availableCommands: SlashCommand[] }).availableCommands;
        if (Array.isArray(cmds)) this.handleCommandsUpdate(path, cmds);
      } else if (method === "session_info_update") {
        const si = params as { sessionId: string; title?: string };
        if (typeof si.sessionId === "string") {
          this.handleInfoUpdate(path, si.sessionId, si.title);
        }
      }
    });
    // Transport reconnects: the SSE leg died and came back, so
    // session/update notifications were missed while it was
    // down. Rebuild the folder's session state from agent truth.
    client.onReconnect(() => {
      console.log(`[sessions] ${path}: agent stream reconnected, resyncing`);
      void this.resyncFolder(path);
    });
  }

  async unregisterFolder(folder: string): Promise<void> {
    const path = normalizeFolder(folder);
    const client = this.clients.get(path);
    if (client) {
      await client.stop();
      this.clients.delete(path);
    }
    this.stopHeartbeat(path);

    const state = this.folders.get(path);
    if (state) {
      for (const sessionId of state.sessions.keys()) {
        const listeners = this.listeners.get(sessionId);
        if (listeners) {
          for (const l of listeners) {
            try {
              l({
                id: globalThis.crypto.randomUUID(),
                role: "system",
                kind: "error",
                text: "Folder unregistered",
                at: Date.now(),
              });
            } catch {}
          }
        }
        this.listeners.delete(sessionId);
      }
    }
    this.folders.delete(path);
  }

  listFolders(): FolderState[] {
    return Array.from(this.folders.values()).sort(
      (a, b) => b.registeredAt - a.registeredAt,
    );
  }

  getFolder(folder: string): FolderState | undefined {
    return this.folders.get(normalizeFolder(folder));
  }

  // -----------------------------------------------------------------------
  // Session lifecycle
  // -----------------------------------------------------------------------

  async createSession(folder: string, title?: string): Promise<SessionState> {
    const state = this.requireFolder(folder);
    const client = this.requireClient(state.path);
    // The agent returns the sessionId plus the initial
    // models/modes advertisements. The model/mode lists are
    // session-scoped in ACP, but pi-acp advertises the same
    // list per session (it's the global set the agent knows
    // about), and the active model/mode may differ. We mirror
    // everything into the folder state so the chat UI can
    // pre-populate the model/mode picker without a second
    // round-trip.
    const res = await client.newSession(state.path);
    this.applySessionCapabilities(state, res);

    const session: SessionState = {
      id: res.sessionId,
      title: title ?? defaultTitle(),
      createdAt: Date.now(),
      messages: [],
      busy: false,
    };
    state.sessions.set(res.sessionId, session);
    state.activeSessionId = res.sessionId;
    return session;
  }

  async loadSession(folder: string, sessionId: string): Promise<SessionState> {
    const state = this.requireFolder(folder);
    const client = this.requireClient(state.path);
    const existing = state.sessions.get(sessionId);
    const session: SessionState = existing ?? {
      id: sessionId,
      title: defaultTitle(),
      createdAt: Date.now(),
      messages: [],
      busy: false,
    };
    // Mark replay in progress and arm a resolver. The first non-chunk
    // session/update after the load resolves this so the caller can
    // snapshot the fully-replayed transcript.
    session.messages = [];
    session.replaying = true;
    const replayDone = new Promise<void>((resolve) => {
      session.replayDoneResolver = resolve;
    });
    // Insert the session into the folder's map BEFORE issuing the
    // RPC. The agent replays the transcript as session/update
    // notifications while we wait here, and the dispatcher drops
    // updates for session ids it can't find. On the page-load path
    // a listSessions stub is usually already in the map, so this
    // went unnoticed; the SSE stream's rehydration path (no prior
    // listSessions) needs the session registered up front.
    state.sessions.set(sessionId, session);
    state.activeSessionId = sessionId;
    try {
      const res = await client.loadSession(sessionId, state.path);
      this.applySessionCapabilities(state, res);
    } catch (err) {
      session.replaying = false;
      session.replayDoneResolver = undefined;
      throw err;
    }
    // Wait for the agent to finish replaying. The notification
    // handler flips session.replaying off when it sees a non-chunk
    // event (e.g. available_commands_update). Fall back to a short
    // timeout so a misbehaving agent doesn't hang the loader.
    await Promise.race([
      replayDone,
      sleep(2000),
    ]);
    session.replaying = false;
    session.replayDoneResolver = undefined;
    return session;
  }

  async resumeSession(
    folder: string,
    sessionId: string,
  ): Promise<SessionState> {
    const state = this.requireFolder(folder);
    const client = this.requireClient(state.path);
    await client.resumeSession(sessionId, state.path);
    const existing = state.sessions.get(sessionId);
    const session: SessionState = existing ?? {
      id: sessionId,
      title: defaultTitle(),
      createdAt: Date.now(),
      messages: [],
      busy: false,
    };
    session.messages = [];
    state.sessions.set(sessionId, session);
    state.activeSessionId = sessionId;
    return session;
  }

  /**
   * Hydrate this folder's session list from the agent. The agent
   * filters by cwd on its side (pi-acp's session/list takes a cwd
   * param), but we also filter again here as a belt-and-braces check
   * for agents that ignore it — otherwise a session from another
   * worktree would leak into this folder's list.
   */
  async listSessions(folder: string): Promise<SessionState[]> {
    const state = this.requireFolder(folder);
    const client = this.requireClient(state.path);
    const list = await client.listSessions(state.path);
    for (const entry of list) {
      if (!entry.sessionId) continue;
      if (entry.cwd && entry.cwd !== state.path) continue;
      const existing = state.sessions.get(entry.sessionId);
      if (!existing) {
        state.sessions.set(entry.sessionId, {
          id: entry.sessionId,
          title: entry.title,
          createdAt: Date.parse(entry.updatedAt ?? "") || Date.now(),
          messages: [],
          busy: false,
        });
      }
    }
    return Array.from(state.sessions.values()).sort(
      (a, b) => b.createdAt - a.createdAt,
    );
  }

  getSession(folder: string, sessionId: string): SessionState | undefined {
    return this.getFolder(folder)?.sessions.get(sessionId);
  }

  subscribe(sessionId: string, listener: SessionListener) {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  /**
   * How many listeners (SSE viewers + internal watchers) are
   * attached to this session right now. The inbox push watcher
   * uses this to suppress notifications when a viewer is
   * already watching the turn live: if the count is >1 besides
   * itself, someone has the conversation open.
   */
  listenerCount(sessionId: string): number {
    return this.listeners.get(sessionId)?.size ?? 0;
  }

  async sendMessage(
    folder: string,
    sessionId: string,
    content: ContentBlock[],
  ): Promise<void> {
    const state = this.getFolder(folder);
    const session = state?.sessions.get(sessionId);
    if (!state || !session) throw new Error("Unknown folder/session");

    // For the visible user message in the transcript, collapse the
    // content blocks into a single string. resource_links show up as
    // "@<name>"; the @-chips above the message (when wired) will
    // render the full attachment list.
    const displayText = content
      .map((c) => (c.type === "text" ? c.text ?? "" : c.name ? "@" + c.name : ""))
      .filter(Boolean)
      .join("\n");

    const userMsg: ChatMessage = {
      id: cryptoRandom(),
      role: "user",
      kind: "text",
      text: displayText,
      at: Date.now(),
    };
    session.messages.push(userMsg);
    this.broadcast(session, userMsg);

    // If a turn is already in flight, pi-acp's session.prompt()
    // will queue this new message for delivery between turns
    // and return when the queued turn eventually completes.
    // Awaiting that future turn would block the chat UI's send
    // handler, so we run the prompt in the background and let
    // the busy/turn-end events drive the session state. The
    // user can keep sending more messages; they accumulate in
    // pi-acp's turnQueue and the chat UI's "Queued (n)" badge
    // tracks the depth. We bump an in-flight counter so the
    // session stays "busy" until every queued prompt has run
    // to completion.
    session.inFlightPrompts = (session.inFlightPrompts ?? 0) + 1;
    if (!session.busy) {
      session.busy = true;
      this.broadcast(session, {
        id: cryptoRandom(),
        role: "system",
        kind: "busy",
        busy: true,
        at: Date.now(),
      });
    }
    void this.runPrompt(state, session, content);
  }

  /**
   * Run a `session/prompt` RPC against the agent and update the
   * session state when it settles. For queued messages (a turn
   * was already in flight when the user pressed send), the
   * pi-acp adapter will hold the request until the queued
   * turn completes, so this can run for an arbitrary amount of
   * time. Callers should `void` it; the busy/not-busy broadcasts
   * drive the UI.
   */
  private async runPrompt(
    state: FolderState,
    session: SessionState,
    content: ContentBlock[],
  ): Promise<void> {
    const client = this.requireClient(state.path);
    const turnDone = this.waitForTurnEnd(session.id);
    try {
      // If the agent has forgotten this sessionId (e.g. the bridge
      // restarted since we last used it), session/load it back in
      // and retry once. If that still fails, give up with a clear
      // error in the chat.
      let res: { stopReason: string };
      try {
        res = await client.prompt(session.id, content);
      } catch (err) {
        const msg = (err as Error).message;
        if (/unknown session|invalid params|not found/i.test(msg)) {
          try {
            await client.loadSession(session.id, state.path);
            res = await client.prompt(session.id, content);
          } catch (err2) {
            throw err2;
          }
        } else {
          throw err;
        }
      }
      const sysMsg: ChatMessage = {
        id: cryptoRandom(),
        role: "system",
        kind: "info",
        text: `Turn ended: ${res.stopReason}`,
        at: Date.now(),
      };
      this.closeStreamingMessages(session);
      session.messages.push(sysMsg);
      this.broadcast(session, sysMsg);
    } catch (err) {
      this.closeStreamingMessages(session);
      const errMsg: ChatMessage = {
        id: cryptoRandom(),
        role: "system",
        kind: "error",
        text: `Error: ${(err as Error).message}`,
        at: Date.now(),
      };
      session.messages.push(errMsg);
      this.broadcast(session, errMsg);
    } finally {
      await Promise.race([turnDone, sleep(1500)]);
      // Decrement the in-flight counter. If there are still
      // other queued prompts running, the session stays busy.
      // Only the last `runPrompt` to finish clears the busy
      // state and broadcasts `busy:false` to the chat.
      session.inFlightPrompts = Math.max(0, (session.inFlightPrompts ?? 1) - 1);
      if (session.inFlightPrompts === 0) {
        session.busy = false;
        session.queueDepth = 0;
        this.broadcast(session, {
          id: cryptoRandom(),
          role: "system",
          kind: "busy",
          busy: false,
          at: Date.now(),
        });
        this.broadcast(session, this.controlMessage({ type: "queueDepth", depth: 0 }));
        // Capture the worktree state at the end of this turn.
        // The snapshot is independent of the user's git history
        // and gives the timeline a recoverable checkpoint.
        const folder = this.folderForSession(session);
        if (folder) {
          void captureTimeline(folder.path, {
            reason: "turn-end",
            sessionId: session.id,
            prompt: promptText(content),
            plan: latestPlan(session),
          });
        }
      }
    }
  }

  cancel(folder: string, sessionId: string) {
    const client = this.clients.get(normalizeFolder(folder));
    if (client) client.cancel(sessionId);
  }

  /**
   * Switch the active mode on the given session. The agent
   * confirms the change and broadcasts `current_mode_update`;
   * we track the resolved value so the UI doesn't have to guess.
   */
  async setMode(
    folder: string,
    sessionId: string,
    modeId: string,
  ): Promise<unknown> {
    const state = this.requireFolder(folder);
    const client = this.requireClient(state.path);
    const res = await client.setMode(sessionId, modeId);
    // Optimistic: if the agent doesn't push a follow-up
    // current_mode_update, mirror the value locally so the UI
    // updates immediately.
    state.currentModeId = modeId;
    return res;
  }

  /**
   * Switch the active model on the given session. ACP does not
   * have a stable RPC for this yet; pi-acp exposes
   * `unstable_set_session_model` and broadcasts
   * `current_model_update` on success. We treat the response
   * as confirmation and update the cached value so the UI
   * doesn't have to wait for the notification.
   */
  async setModel(
    folder: string,
    sessionId: string,
    modelId: string,
  ): Promise<unknown> {
    const state = this.requireFolder(folder);
    const client = this.requireClient(state.path);
    const res = await client.unstableSetSessionModel(sessionId, modelId);
    // Optimistic: see setMode.
    state.currentModelId = modelId;
    return res;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Merge the models/modes advertised by the agent in the
   * `session/new` or `session/load` response into the folder
   * state. Called from both createSession and loadSession so the
   * chat UI has the data it needs to render the model/mode
   * picker on the first frame, even before any
   * `current_model_update` notification has had a chance to
   * arrive.
   *
   * The fields on the response are all optional; the agent may
   * legitimately omit `models`/`modes` if, for example, the
   * user is not yet authenticated. We treat `undefined` and
   * `null` as "no change" so we don't blow away an existing
   * cache when reloading a session.
   */
  private applySessionCapabilities(
    state: FolderState,
    res: {
      models?: { currentModelId?: string; availableModels?: AvailableModel[] } | null;
      modes?: { currentModeId?: string; availableModes?: AvailableMode[] } | null;
    },
  ) {
    if (res.models !== undefined && res.models !== null) {
      if (Array.isArray(res.models.availableModels)) {
        state.availableModels = res.models.availableModels;
      }
      if (typeof res.models.currentModelId === "string") {
        state.currentModelId = res.models.currentModelId;
      }
    }
    if (res.modes !== undefined && res.modes !== null) {
      if (Array.isArray(res.modes.availableModes)) {
        state.availableModes = res.modes.availableModes;
      }
      if (typeof res.modes.currentModeId === "string") {
        state.currentModeId = res.modes.currentModeId;
      }
    }
  }

  private requireFolder(folder: string): FolderState {
    const state = this.folders.get(normalizeFolder(folder));
    if (!state) {
      throw new Error(
        `Unknown folder ${folder}. Register it first (POST /api/folders).`,
      );
    }
    return state;
  }

  private requireClient(folder: string): AcpClient {
    const client = this.clients.get(folder);
    if (!client) throw new Error(`No ACP client for ${folder}.`);
    return client;
  }

  private broadcast(session: SessionState, msg: ChatMessage) {
    // During a session/load replay the transcript is rebuilt
    // wholesale; live tabs must not receive the replayed
    // messages one by one — they'd double-append onto what they
    // already show. They get the authoritative snapshot on their
    // next stream connect instead: api.stream serves
    // session.messages after the replay completes, and a resync
    // control message asks live tabs to reconnect.
    if (session.replaying) return;
    const set = this.listeners.get(session.id);
    if (!set) return;
    for (const l of set) {
      try {
        l(msg);
      } catch (err) {
        console.error("[sessions] listener error", err);
      }
    }
  }

  private waitForTurnEnd(sessionId: string): Promise<ChatMessage> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(sessionId);
        resolve({
          id: cryptoRandom(),
          role: "system",
          kind: "info",
          text: "Turn ended (timeout)",
          at: Date.now(),
        });
      }, HEARTBEAT_TIMEOUT_MS);
      this.turnWaiters.set(sessionId, { resolve, timer });
    });
  }

  /**
   * Walk back through the session's transcript and clear the
   * streaming flag on the most recent text/thought message. The
   * agent's chunk events leave messages in `streaming: true` state
   * while they're being written; once a turn is done, the cursor
   * should disappear. Called whenever a turn is settled so the
   * snapshot at stream-connect also reflects a clean state.
   *
   * The `streaming` flag is still used to drive the live cursor
   * during a turn, but the rendered cursor no longer appears on
   * finished messages — the chat area border is the only
   * "agent is working" indicator, see ChatView.
   */
  private closeStreamingMessages(session: SessionState) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i];
      if (m.kind === "text" || m.kind === "thought") {
        if (m.streaming) {
          m.streaming = false;
          this.broadcast(session, m);
        }
        return;
      }
    }
  }

  private settleTurn(sessionId: string) {
    const waiter = this.turnWaiters.get(sessionId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.turnWaiters.delete(sessionId);
    const session = this.findSession(sessionId);
    if (session) this.closeStreamingMessages(session);
    setTimeout(
      () =>
        waiter.resolve({
          id: cryptoRandom(),
          role: "system",
          kind: "info",
          text: "Turn ended",
          at: Date.now(),
        }),
      50,
    );
  }

  // -- ACP update dispatch ------------------------------------------------

  private handleSessionUpdate(sessionId: string, update: SessionUpdate) {
    const session = this.findSession(sessionId);
    if (process.env.DEBUG) {
      console.log(
        `[acp] update ${update.sessionUpdate} for ${sessionId.slice(0, 8)} known=${!!session} replaying=${session?.replaying}`,
      );
    }
    if (!session) return;
    const id = cryptoRandom();

    // Replay boundary: any non-chunk event after a load signals
    // that the agent has finished replaying history. Resolve the
    // loader's wait so it can snapshot the full transcript.
    if (session.replaying && !this.isChunkUpdate(update.sessionUpdate)) {
      session.replaying = false;
      const resolve = session.replayDoneResolver;
      session.replayDoneResolver = undefined;
      resolve?.();
    }

    // Session-scoped metadata updates from pi-acp: these update
    // the folder's view of the active model/mode/commands but
    // don't go into the transcript. They arrive on the same
    // `session/update` envelope as the message/tool chunks
    // above; the difference is the inner `sessionUpdate` kind.
    const u = update as SessionUpdate & {
      currentModelId?: string;
      currentModeId?: string;
      availableCommands?: SlashCommand[];
      title?: string;
    };
    const folder = this.folderForSession(session);
    if (folder) {
      if (
        update.sessionUpdate === "current_model_update" &&
        typeof u.currentModelId === "string"
      ) {
        this.handleModelUpdate(folder.path, u.currentModelId);
        return;
      }
      if (
        update.sessionUpdate === "current_mode_update" &&
        typeof u.currentModeId === "string"
      ) {
        this.handleModeUpdate(folder.path, u.currentModeId);
        return;
      }
      if (
        update.sessionUpdate === "available_commands_update" &&
        Array.isArray(u.availableCommands)
      ) {
        this.handleCommandsUpdate(folder.path, u.availableCommands);
        return;
      }
      if (update.sessionUpdate === "session_info_update") {
        this.handleInfoUpdate(folder.path, sessionId, u.title);
        // pi-acp publishes `session_info_update` with
        // `_meta.piAcp.queueDepth` whenever the queue depth
        // changes (a prompt was queued, a queued prompt was
        // dispatched, or the queue was cleared on cancel). The
        // chat UI uses this to show a "Queued (n)" badge in
        // the composer, so the user knows their next message
        // will be delivered between turns rather than run
        // immediately.
        const qDepth = (
          u as { _meta?: { piAcp?: { queueDepth?: number } } }
        )._meta?.piAcp?.queueDepth;
        if (typeof qDepth === "number") {
          this.handleQueueUpdate(folder.path, sessionId, qDepth);
        }
        return;
      }
    }

    // agent_message_chunk
    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content &&
      !Array.isArray(update.content)
    ) {
      const text = update.content.type === "text" ? update.content.text ?? "" : "";
      this.appendToStream(session, id, "agent", "text", text);
      return;
    }

    // agent_thought_chunk (separate stream from message)
    if (
      update.sessionUpdate === "agent_thought_chunk" &&
      update.content &&
      !Array.isArray(update.content)
    ) {
      const text = update.content.type === "text" ? update.content.text ?? "" : "";
      this.appendToStream(session, id, "agent", "thought", text);
      return;
    }

    // user_message_chunk (replay during session/load)
    if (
      update.sessionUpdate === "user_message_chunk" &&
      update.content &&
      !Array.isArray(update.content)
    ) {
      const text = update.content.type === "text" ? update.content.text ?? "" : "";
      if (!text) return;
      session.messages.push({
        id,
        role: "user",
        kind: "text",
        text,
        at: Date.now(),
      });
      this.broadcast(session, session.messages[session.messages.length - 1]);
      return;
    }

    // tool_call
    if (update.sessionUpdate === "tool_call") {
      const msg: ChatMessage = {
        id,
        role: "agent",
        kind: "tool",
        toolCallId: update.toolCallId ?? id,
        title: update.title ?? "Tool call",
        toolKind: update.kind,
        status: (update.status as ChatMessage & { kind: "tool" } extends infer T
          ? T extends { status: infer S }
            ? S
            : never
          : never) ?? "pending",
        content: Array.isArray(update.content) ? update.content : undefined,
        locations: (update as { locations?: Array<{ path: string; line?: number }> })
          .locations,
        at: Date.now(),
      };
      session.messages.push(msg);
      this.broadcast(session, msg);
      return;
    }

    // tool_call_update
    if (update.sessionUpdate === "tool_call_update") {
      const toolCallId = update.toolCallId ?? id;
      for (let i = session.messages.length - 1; i >= 0; i--) {
        const m = session.messages[i];
        if (m.kind === "tool" && m.toolCallId === toolCallId) {
          if (update.status) m.status = update.status as typeof m.status;
          if (Array.isArray(update.content)) m.content = update.content;
          if (update.title) m.title = update.title;
          this.broadcast(session, m);
          break;
        }
      }
      if (update.status === "completed" || update.status === "failed") {
        this.settleTurn(sessionId);
      }
      return;
    }

    // plan (replaces wholesale on each update, per ACP spec)
    if (update.sessionUpdate === "plan") {
      const msg: ChatMessage = {
        id,
        role: "agent",
        kind: "plan",
        entries: (update.entries ?? []).map((e) => ({
          content: e.content,
          priority: e.priority as "high" | "medium" | "low" | undefined,
          status: e.status as "pending" | "in_progress" | "completed" | undefined,
        })),
        at: Date.now(),
      };
      session.messages.push(msg);
      this.broadcast(session, msg);
      return;
    }

    if (process.env.DEBUG) {
      console.log("[acp] unhandled update", update.sessionUpdate, update);
    }
  }

  /**
   * Append a streamed text chunk to the in-progress text/thought message.
   * If a message of the same kind is already streaming, extend it;
   * otherwise create a new one.
   */
  private appendToStream(
    session: SessionState,
    id: string,
    role: "agent",
    kind: "text" | "thought",
    chunk: string,
  ) {
    let last = session.messages[session.messages.length - 1];
    if (
      !last ||
      last.kind !== kind ||
      last.role !== role ||
      !last.streaming
    ) {
      const msg: ChatMessage = {
        id,
        role,
        kind,
        text: chunk,
        // Replayed messages are not actively streaming — they were
        // already on disk, no live cursor to draw.
        streaming: session.replaying ? false : true,
        at: Date.now(),
      };
      session.messages.push(msg);
      this.broadcast(session, msg);
      return;
    }
    // Extend in place
    last.text = (last.text ?? "") + chunk;
    last.at = Date.now();
    this.broadcast(session, last);
  }

  private handleModeUpdate(folder: string, modeId: string) {
    const state = this.folders.get(folder);
    if (!state) return;
    state.currentModeId = modeId;
    // Broadcast on every session in the folder
    for (const session of state.sessions.values()) {
      this.broadcast(session, this.controlMessage({ type: "currentMode", modeId }));
    }
  }

  private handleModelUpdate(folder: string, modelId: string) {
    const state = this.folders.get(folder);
    if (!state) return;
    state.currentModelId = modelId;
    for (const session of state.sessions.values()) {
      this.broadcast(session, this.controlMessage({ type: "currentModel", modelId }));
    }
  }

  private handleCommandsUpdate(folder: string, commands: SlashCommand[]) {
    const state = this.folders.get(folder);
    if (!state) return;
    state.availableCommands = commands ?? [];
    // The command list is the same across sessions in the folder
    // (pi-acp advertises the same list for every new session), so
    // broadcasting to all of them is cheap.
    for (const session of state.sessions.values()) {
      this.broadcast(
        session,
        this.controlMessage({
          type: "availableCommands",
          commands: state.availableCommands,
        }),
      );
    }
  }

  private handleInfoUpdate(
    folder: string,
    sessionId: string,
    title: string | undefined,
  ) {
    const state = this.folders.get(folder);
    const session = state?.sessions.get(sessionId);
    if (state && session && title) {
      session.title = title;
    }
  }

  /**
   * Update the cached queue depth for a session and broadcast
   * it to the chat as a control message. The Composer reads
   * these and renders a "Queued (n)" badge so the user knows
   * how many messages are waiting to be delivered between turns.
   */
  private handleQueueUpdate(
    folder: string,
    sessionId: string,
    depth: number,
  ) {
    const state = this.folders.get(folder);
    const session = state?.sessions.get(sessionId);
    if (!session) return;
    if (session.queueDepth === depth) return;
    session.queueDepth = depth;
    this.broadcast(
      session,
      this.controlMessage({ type: "queueDepth", depth }),
    );
  }

  private controlMessage(control: ControlUpdate): ChatMessage {
    return {
      id: cryptoRandom(),
      role: "system",
      kind: "control",
      control,
      at: Date.now(),
    };
  }

  private isChunkUpdate(kind: string | undefined): boolean {
    return (
      kind === "agent_message_chunk" ||
      kind === "agent_thought_chunk" ||
      kind === "user_message_chunk"
    );
  }

  private findSession(sessionId: string): SessionState | undefined {
    for (const folder of this.folders.values()) {
      const s = folder.sessions.get(sessionId);
      if (s) return s;
    }
    // Unknown sessionId. Don't fabricate a placeholder — that would
    // let the agent push updates for an ID we never asked for, and
    // those messages would never reach the user. Drop them instead.
    return undefined;
  }

  /**
   * Reverse of `findSession`: given a session state, return the
   * folder it belongs to. Used by the session/update dispatcher
   * to route folder-scoped metadata updates (model/mode/
   * commands) back to the right folder, since pi-acp's updates
   * only carry the sessionId, not the folder path.
   */
  private folderForSession(session: SessionState): FolderState | undefined {
    for (const folder of this.folders.values()) {
      if (folder.sessions.get(session.id) === session) return folder;
    }
    return undefined;
  }

  // -- Resync -----------------------------------------------------------

  /**
   * Reconcile a folder's in-memory session state with agent
   * truth after a healing event: the SSE stream reconnected
   * after a drop, or the heartbeat recovered from `degraded`.
   * Every session/update pushed while the leg was down was lost,
   * so each session we hold is replayed via session/load (the
   * agent replays the full transcript). Replay broadcasts are
   * suppressed (see broadcast); each session's live viewers are
   * asked to reconnect and re-snapshot via a `resync` control
   * message.
   *
   * Replays every held session, not just busy ones: a turn that
   * ran during the outage settles its prompt RPC through the
   * error path (POST failed too), which leaves busy=false on a
   * transcript that is now missing the agent's reply. Stale
   * state must never be served to a reconnecting viewer as a
   * snapshot, and "not busy" is not proof of "unchanged".
   */
  private async resyncFolder(folder: string) {
    const path = normalizeFolder(folder);
    const state = this.folders.get(path);
    const client = this.clients.get(path);
    if (!state || !client) return;
    if (this.resyncInFlight.has(path)) return;
    this.resyncInFlight.add(path);
    if (process.env.DEBUG)
      console.log(`[resync] ${path}: start`);
    try {
      // Which sessions does the agent still know about?
      let known: Set<string> | null = null;
      try {
        const list = await client.listSessions(state.path);
        known = new Set(
          list
            .filter((e) => !e.cwd || e.cwd === state.path)
            .map((e) => e.sessionId),
        );
      } catch (err) {
        console.warn(
          `[resync] ${path}: session/list failed: ${(err as Error).message}`,
        );
        return;
      }
      // loadSession has an activeSessionId side effect; keep the
      // folder's notion of the active session stable across resync.
      const prevActive = state.activeSessionId;
      for (const session of Array.from(state.sessions.values())) {
        // Someone else is already replaying this session (page
        // load, prompt retry). Its state is being rebuilt; the
        // viewer will snapshot after it completes.
        if (session.replaying) continue;
        // The agent lost this session (fresh agent process,
        // cleared sessions dir). A pending prompt RPC, if any,
        // will surface the error; don't replay what isn't there.
        if (known && !known.has(session.id)) continue;
        try {
          if (process.env.DEBUG)
            console.log(
              `[resync] replay ${session.id.slice(0, 8)} (known=${known?.has(session.id)}) msgs-before=${session.messages.length}`,
            );
          await this.loadSession(state.path, session.id);
          if (process.env.DEBUG)
            console.log(
              `[resync] replay done msgs-after=${session.messages.length} replaying=${session.replaying}`,
            );
          this.broadcast(session, this.controlMessage({ type: "resync" }));
        } catch (err) {
          console.warn(
            `[resync] ${path}/${session.id}: replay failed: ${(err as Error).message}`,
          );
        }
      }
      state.activeSessionId = prevActive;
    } finally {
      this.resyncInFlight.delete(path);
      if (process.env.DEBUG) console.log(`[resync] ${path}: done`);
    }
  }

  // -- Heartbeat ---------------------------------------------------------

  /**
   * Liveness probe of the agent leg. A failing ping does NOT
   * unregister the folder: it flips the folder to `degraded`
   * (kept in the UI, sessions and clients preserved) and keeps
   * pinging forever. The launcher's periodic re-registration
   * or a network recovery brings the endpoint back, and the
   * recovery resyncs. The old three-strike unregister destroyed
   * perfectly recoverable state over a 30-second blip.
   */
  private startHeartbeat(folder: string) {
    // Idempotent: safe to call from every registration path.
    this.stopHeartbeat(folder);
    const tick = async () => {
      const state = this.folders.get(folder);
      const client = this.clients.get(folder);
      if (!state || !client) return;
      try {
        // Cap the ping so a hung bridge can't pile up concurrent
        // ticks. Anything that slow counts as a failure.
        const ok = await Promise.race([
          client.ping(),
          sleep(HEARTBEAT_INTERVAL_MS).then(() => false),
        ]);
        if (!ok) throw new Error("ping failed");
        state.lastSeenAt = Date.now();
        if (state.status === "degraded") {
          state.status = "ok";
          console.log(`[heartbeat] ${folder} recovered`);
          // The endpoint was unreachable: notifications were
          // missed. Rebuild every session from agent truth.
          void this.resyncFolder(folder);
        }
      } catch (err) {
        if (state.status !== "degraded") {
          state.status = "degraded";
          console.warn(
            `[heartbeat] ${folder} degraded: ${(err as Error).message}`,
          );
        }
      }
    };
    this.heartbeats.set(
      folder,
      setInterval(() => void tick(), HEARTBEAT_INTERVAL_MS),
    );
    void tick(); // probe immediately on registration
  }

  private stopHeartbeat(folder: string) {
    const t = this.heartbeats.get(folder);
    if (t) clearInterval(t);
    this.heartbeats.delete(folder);
  }
}

// -----------------------------------------------------------------------
// Types & singletons
// -----------------------------------------------------------------------

export interface SessionState {
  id: string;
  title?: string;
  createdAt: number;
  messages: ChatMessage[];
  busy: boolean;
  /**
   * Number of in-flight prompt RPCs against the agent. The
   * session is "busy" while this is > 0. Multiple prompts can
   * be in flight at once: the first one runs immediately, and
   * any prompts sent while the first is running are queued by
   * pi-acp and delivered between turns. Each queued prompt
   * corresponds to one awaiting `client.prompt()` call, all of
   * which eventually resolve as pi-acp drains its turnQueue.
   * The chat UI shows a "Queued (n)" badge sourced from
   * `queueDepth` (mirrored from the agent's session_info_update
   * metadata), not from this counter.
   */
  inFlightPrompts?: number;
  /**
   * True while session/load is replaying history into the in-memory
   * transcript. Replayed chunks should not be marked as streaming
   * (no live cursor) and the loader should wait for it to clear
   * before snapshotting the transcript for the client.
   */
  replaying?: boolean;
  /**
   * Resolved by the notification handler when the replay is
   * complete (first non-chunk session/update). The loadSession
   * awaiter uses this to know when it's safe to return.
   */
  replayDoneResolver?: () => void;
  /**
   * Number of prompts pi has queued for delivery between turns.
   * Mirrored from `session_info_update._meta.piAcp.queueDepth`.
   * A value of 0 means the agent is idle; >0 means a turn is
   * running and additional prompts have been queued. The chat
   * UI shows a "Queued (n)" badge in the composer.
   */
  queueDepth?: number;
}

export interface FolderState {
  path: string;
  agentUrl: string;
  agentName?: string;
  registeredAt: number;
  /**
   * Liveness of the agent leg. `degraded` = heartbeat pings are
   * failing; the folder is kept (sessions, clients, heartbeats)
   * and keeps being probed — the launcher's periodic
   * re-registration or a network recovery flips it back to ok,
   * which triggers a resync. Never auto-removed; DELETE
   * /api/folders is the only removal.
   */
  status: "ok" | "degraded";
  /** Last time the agent answered a heartbeat ping (epoch ms). */
  lastSeenAt: number;
  sessions: Map<string, SessionState>;
  activeSessionId: string | null;
  /**
   * Slash commands the agent advertises via
   * `available_commands_update`. Refreshed per session; the
   * agent may re-advertise the same list on every new session.
   */
  availableCommands: SlashCommand[];
  /**
   * Models the agent advertises for the active session. Populated
   * from the `session/new` or `session/load` response. The list
   * is session-scoped in ACP, but pi-acp publishes the same
   * global list per session, so we cache the latest seen set on
   * the folder.
   */
  availableModels: AvailableModel[];
  /**
   * Modes (thinking levels) the agent advertises for the
   * active session. Same shape as `availableModels`.
   */
  availableModes: AvailableMode[];
  /** Currently active mode id, mirrored from current_mode_update. */
  currentModeId: string | null;
  /** Currently active model id, mirrored from current_model_update. */
  currentModelId: string | null;
}

type SessionListener = (msg: ChatMessage) => void;
type TurnWaiter = {
  resolve: (msg: ChatMessage) => void;
  timer: NodeJS.Timeout;
};

function cryptoRandom() {
  return globalThis.crypto.randomUUID();
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeFolder(folder: string): string {
  return folder.replace(/\/+$/, "");
}

function defaultTitle(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Session ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function promptText(content: ContentBlock[]): string {
  return content
    .map((c) => (c.type === "text" ? c.text ?? "" : c.name ? "@" + c.name : ""))
    .filter(Boolean)
    .join("\n");
}

function latestPlan(session: SessionState): string[] {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.kind === "plan") {
      return m.entries.map((e) => e.content);
    }
  }
  return [];
}

declare global {
  // eslint-disable-next-line no-var
  // Deliberately NOT derived from BRAND_SLUG: this is the globalThis
  // HMR cache key. Renaming it would orphan any process mid-reload
  // (old bundle's value still pinned on globalThis, new bundle would
  // build a fresh SessionManager and double the folders). Only touch
  // this when the app is changing in a way that already invalidates
  // every running server.
  var __radharc_sessions: SessionManager | undefined;
}

export const sessionManager: SessionManager =
  globalThis.__radharc_sessions ??
  (globalThis.__radharc_sessions = new SessionManager());

/** Helper for the API layer to project FolderState → wire shape. */
export function folderSummary(state: FolderState): FolderSummary {
  return {
    path: state.path,
    agentName: state.agentName,
    agentUrl: state.agentUrl,
    registeredAt: state.registeredAt,
    status: state.status,
    lastSeenAt: state.lastSeenAt,
    sessions: Array.from(state.sessions.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(sessionSummary),
  };
}

export function sessionSummary(s: SessionState): SessionSummary {
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    messageCount: s.messages.length,
  };
}
