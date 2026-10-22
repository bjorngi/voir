/**
 * ACP (Agent Client Protocol) JSON-RPC 2.0 client.
 *
 * Transport-agnostic. The transport interface is small:
 *
 *   send(message): Promise<void | response>   // request/notification → response or ack
 *   onMessage(cb): () => void                  // subscribe to server-pushed messages
 *   close(): void
 *
 * We ship one transport (`HttpJsonRpcTransport`) that speaks ACP over a
 * plain HTTP endpoint exposed by an external sandbox script:
 *
 *   - POST <url>        body = single JSON-RPC message
 *                       200 with JSON-RPC response (for requests)
 *                       204 No Content      (for notifications)
 *   - GET  <url>        Content-Type: text/event-stream; one JSON-RPC
 *                       message per `data:` line; this is the server-pushed
 *                       notification stream (session/update, etc.)
 *
 * Voir does NOT spawn pi-acp itself. An external script (the sandbox
 * manager) does that, exposes it via the HTTP endpoint, and then calls
 *   POST /api/folders        { path, agent: { url } }
 * on Voir to register the folder. When the script tears the agent
 * down, it calls
 *   DELETE /api/folders      { path }
 * (or Voir notices on heartbeat and marks the folder degraded
 * until the launcher's periodic re-registration brings it back).
 */

import type {
  AvailableModel,
  AvailableMode,
  ContentBlock,
  ToolCallContentBlock,
} from "./chat-types";
import { BRAND, BRAND_SLUG } from "./brand";

export interface SessionUpdate {
  sessionUpdate: string;
  content?: ContentBlock | ToolCallContentBlock[];
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  entries?: Array<{
    content: string;
    priority?: string;
    status?: string;
  }>;
}

export interface PromptResult {
  stopReason: string;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  sessionCapabilities?: {
    resume?: unknown;
    close?: unknown;
    fork?: unknown;
    list?: unknown;
  };
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  agentInfo?: { name: string; title?: string; version?: string };
  authMethods?: Array<unknown>;
}

export interface SessionListEntry {
  sessionId: string;
  title?: string;
  updatedAt?: string;
  cwd?: string;
}

export interface SessionListResult {
  sessions: SessionListEntry[];
}

/**
 * The shape of `session/new` and `session/load` results. The
 * `models` and `modes` fields are advertised by the agent on
 * session creation/load and may be missing on a brand-new or
 * unauthenticated session.
 */
export interface SessionCapabilities {
  sessionId: string;
  models?: {
    currentModelId?: string;
    availableModels?: AvailableModel[];
  } | null;
  modes?: {
    currentModeId?: string;
    availableModes?: AvailableMode[];
  } | null;
}

export type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export interface AcpTransport {
  /** Send a JSON-RPC message. For requests, resolves with the response. For
   *  notifications, resolves with `undefined` once the server has acked. */
  send(msg: JsonRpcMessage): Promise<JsonRpcMessage | undefined>;
  /** Subscribe to server-pushed JSON-RPC messages. Returns an unsubscribe. */
  onMessage(cb: (msg: JsonRpcMessage) => void): () => void;
  close(): void;
  /** Optional liveness probe used for heartbeats. Returns true if alive. */
  ping?(): Promise<boolean>;
  /**
   * Subscribe to transport-level recovery: the stream (or
   * endpoint) died and has now come back. Fired once per
   * successful reopen — never for the first open. Transports
   * that can't detect recovery may omit this.
   */
  onReconnect?(cb: () => void): () => void;
}

// -----------------------------------------------------------------------
// HTTP transport
// -----------------------------------------------------------------------

export class HttpJsonRpcTransport implements AcpTransport {
  private listeners = new Set<(msg: JsonRpcMessage) => void>();
  private reconnectListeners = new Set<() => void>();
  private sseAbort: AbortController | null = null;
  private closed = false;
  /** True once the endpoint has ever served us an SSE stream. */
  private everOpened = false;
  /** Backoff attempt counter; reset on every successful open. */
  private retryAttempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;

  constructor(
    public readonly url: string,
    opts?: { backoffBaseMs?: number; backoffCapMs?: number },
  ) {
    this.backoffBaseMs = opts?.backoffBaseMs ?? 1_000;
    this.backoffCapMs = opts?.backoffCapMs ?? 30_000;
  }

  async send(msg: JsonRpcMessage): Promise<JsonRpcMessage | undefined> {
    if (this.closed) throw new Error("transport closed");
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });
    if (res.status === 204) return undefined; // notification ack
    if (!res.ok) {
      throw new Error(
        `ACP HTTP ${this.url} returned ${res.status} ${res.statusText}`,
      );
    }
    const text = await res.text();
    if (!text) return undefined;
    return JSON.parse(text) as JsonRpcMessage;
  }

  onMessage(cb: (msg: JsonRpcMessage) => void): () => void {
    this.listeners.add(cb);
    if (!this.sseAbort) this.openStream();
    return () => {
      this.listeners.delete(cb);
    };
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.sseAbort?.abort();
    this.sseAbort = null;
  }

  async ping(): Promise<boolean> {
    // 5s timeout so a half-open connection can't leave pings hanging
    // past the 10s heartbeat interval. The acp-spawn bridge answers
    // this locally: 204 = alive, 503 = bridge up but agent child
    // dead, anything else / fetch error = transport down.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5_000);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping" }),
        signal: ctl.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  onReconnect(cb: () => void): () => void {
    this.reconnectListeners.add(cb);
    return () => this.reconnectListeners.delete(cb);
  }

  /**
   * Open (or reopen) the SSE notification stream.
   *
   * A dropped stream is retried with backoff forever once this
   * endpoint has ever served us one: a dead GET is almost always
   * a proxy timeout or a network blip, not a decision by the
   * agent. The alternative — silently degrading to request/
   * response-only — loses every session/update forever while
   * POSTs keep working, so prompts succeed and the transcript
   * silently diverges from the agent.
   *
   * Endpoints that never offered SSE (non-200, or not an
   * event-stream) are left alone: request/response-only is a
   * legitimate agent shape. A fetch *failure* (unreachable) is
   * retried even then — unreachable is not a policy.
   */
  private openStream() {
    if (this.closed) return;
    this.sseAbort = new AbortController();
    fetch(this.url, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal: this.sseAbort.signal,
    })
      .then(async (res) => {
        const ct = res.headers.get("content-type") ?? "";
        if (!res.ok || !res.body || !ct.includes("text/event-stream")) {
          // No SSE here. First time: accept the endpoint as
          // request/response-only. After we've had a stream:
          // the endpoint came back wrong or a proxy is
          // erroring — keep trying.
          if (this.everOpened) this.scheduleStreamRetry();
          return;
        }
        const wasReopen = this.everOpened;
        this.everOpened = true;
        this.retryAttempt = 0;
        if (wasReopen) {
          for (const l of this.reconnectListeners) {
            try {
              l();
            } catch {}
          }
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        if (process.env.DEBUG)
          console.log(
            `[sse] ${this.url} stream open (reopen=${wasReopen})`,
          );
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            try {
              const msg = JSON.parse(data) as JsonRpcMessage;
              for (const l of this.listeners) {
                try {
                  l(msg);
                } catch {}
              }
            } catch {
              if (process.env.DEBUG)
                console.log(`[sse] ${this.url} unparseable: ${data.slice(0, 60)}`);
            }
          }
        }
        if (process.env.DEBUG) console.log(`[sse] ${this.url} stream done`);
        // Server ended the stream (bridge restart, proxy cut,
        // agent recycling). Reopen unless we're closing down.
        if (!this.closed) this.scheduleStreamRetry();
      })
      .catch((err) => {
        if (process.env.DEBUG)
          console.log(
            `[sse] ${this.url} open failed: ${(err as Error).message}`,
          );
        // Open failed: endpoint unreachable. Retry with backoff
        // regardless of everOpened — unreachable is transient by
        // definition, and we must not strand an agent that
        // supports SSE but was momentarily down at open time.
        if (!this.closed) this.scheduleStreamRetry();
      });
  }

  private scheduleStreamRetry() {
    if (this.closed || this.retryTimer !== null) return;
    const exp = Math.min(
      this.backoffCapMs,
      this.backoffBaseMs * 2 ** Math.min(this.retryAttempt, 5),
    );
    const delay = exp * (0.75 + Math.random() * 0.5); // jitter
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.openStream();
    }, delay);
  }
}

// -----------------------------------------------------------------------
// AcpClient: transport-agnostic
// -----------------------------------------------------------------------

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export type AcpNotification = (method: string, params: unknown) => void;

export interface AcpClientOptions {
  /** Free-form label, used for logging. */
  label: string;
  /** A function returning a fresh transport. Called once on `start()`. */
  transport: () => AcpTransport;
}

export class AcpClient {
  private transport: AcpTransport | null = null;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<AcpNotification>();
  private reconnectListeners = new Set<() => void>();
  private capabilities: InitializeResult | null = null;
  private unsubscribeStream: (() => void) | null = null;
  public readonly label: string;
  private readonly transportFactory: () => AcpTransport;

  constructor(opts: AcpClientOptions) {
    this.label = opts.label;
    this.transportFactory = opts.transport;
  }

  /** Open the transport and complete the initialize handshake. */
  async start(): Promise<InitializeResult> {
    if (this.transport) return this.capabilities!;
    this.transport = this.transportFactory();
    this.unsubscribeStream = this.transport.onMessage((msg) => {
      // Response to a request we sent. The transport's
      // send() promise may also resolve this same request
      // (for an in-band HTTP response), in which case the
      // pending entry is already gone and this is a no-op.
      if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
        this.settle(msg.id, msg);
        return;
      }
      // Server-pushed notification
      if (msg.method) {
        for (const l of this.listeners) {
          try {
            l(msg.method, msg.params);
          } catch (err) {
            console.error("[acp] listener error", err);
          }
        }
      }
    });

    // Transport-level reconnects: the agent leg died and came
    // back, so session/update notifications were missed while
    // it was down. Callers (the session manager) resync from
    // agent truth when this fires.
    this.transport.onReconnect?.(() => {
      for (const l of this.reconnectListeners) {
        try {
          l();
        } catch (err) {
          console.error("[acp] reconnect listener error", err);
        }
      }
    });

    this.capabilities = await this.request<InitializeResult>("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: BRAND_SLUG,
        title: BRAND,
        version: "0.1.0",
      },
    });

    return this.capabilities;
  }

  onNotification(listener: AcpNotification) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Subscribe to transport-level recovery (stream dropped and
   * reopened). May be called before `start()`; listeners are
   * attached once the transport exists.
   */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  capabilities_info(): InitializeResult | null {
    return this.capabilities;
  }

  isAlive() {
    return this.transport !== null;
  }

  /**
   * Create a new session. Returns the full session capability
   * blob from the agent: sessionId plus the initial `models` /
   * `modes` advertisements. The agent is allowed to omit either
   * field (e.g. when it has not authenticated yet), so callers
   * should treat both as optional.
   */
  async newSession(
    cwd: string,
    mcpServers: unknown[] = [],
  ): Promise<SessionCapabilities> {
    return await this.request<SessionCapabilities>("session/new", {
      cwd,
      mcpServers,
    });
  }

  /**
   * Load an existing session. The agent replies with the same
   * capability blob as `newSession` (sessionId, models, modes),
   * followed by an asynchronous replay of the session history
   * as `session/update` notifications.
   */
  async loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: unknown[] = [],
  ): Promise<SessionCapabilities> {
    return await this.request<SessionCapabilities>("session/load", {
      sessionId,
      cwd,
      mcpServers,
    });
  }

  async resumeSession(
    sessionId: string,
    cwd: string,
    mcpServers: unknown[] = [],
  ): Promise<unknown> {
    return await this.request<unknown>("session/resume", {
      sessionId,
      cwd,
      mcpServers,
    });
  }

  async listSessions(cwd: string): Promise<SessionListEntry[]> {
    const res = await this.request<SessionListResult | null>("session/list", {
      cwd,
    });
    return res?.sessions ?? [];
  }

  cancel(sessionId: string) {
    this.notify("session/cancel", { sessionId });
  }

  /**
   * Switch the session's current mode. The agent confirms the
   * change and broadcasts a `current_mode_update` notification
   * carrying the new modeId. We don't need to react to the
   * response here, but we still return it for callers that want
   * to surface errors.
   */
  async setMode(sessionId: string, modeId: string): Promise<unknown> {
    return await this.request("session/set_mode", { sessionId, modeId });
  }

  /**
   * Switch the session's current model. ACP does not yet have a
   * stable method for this; pi-acp exposes the RPC under
   * `session/set_model` (marked **UNSTABLE** in the SDK schema,
   * since the spec doesn't have a stable model field yet) and
   * does NOT broadcast a `current_model_update` notification on
   * success — only the response tells us the change was
   * accepted. Clients should treat the response as
   * confirmation and update their local cache optimistically.
   *
   * The modelId must be the full `provider/id` string the
   * agent advertised in the `session/new` result
   * (e.g. "anthropic/claude-sonnet-4-5").
   */
  async unstableSetSessionModel(
    sessionId: string,
    modelId: string,
  ): Promise<unknown> {
    return await this.request("session/set_model", {
      sessionId,
      modelId,
    });
  }

  async prompt(
    sessionId: string,
    prompt: ContentBlock[],
  ): Promise<PromptResult> {
    return await this.request<PromptResult>("session/prompt", {
      sessionId,
      prompt,
    });
  }

  async ping(): Promise<boolean> {
    return (await this.transport?.ping?.()) ?? true;
  }

  async stop() {
    this.unsubscribeStream?.();
    this.unsubscribeStream = null;
    this.transport?.close();
    this.transport = null;
  }

  // ---- internals -------------------------------------------------------

  /**
   * Resolve or reject the pending entry for a request id. A
   * no-op if the entry is gone (already settled by the other
   * response path), so the in-band HTTP response and the SSE
   * push can race without double-settling.
   */
  private settle(id: number, response: JsonRpcMessage) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (response.error) {
      p.reject(
        new Error(`ACP error ${response.error.code}: ${response.error.message}`),
      );
    } else {
      p.resolve(response.result);
    }
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    const id = ++this.nextId;
    const msg: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      if (!this.transport) {
        reject(new Error("ACP client not started"));
        return;
      }
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.transport
        .send(msg)
        .then((response) => {
          // A 204 (notification ack) or a transport that
          // streams the response over SSE: the response will
          // arrive via the onMessage path. In-band HTTP
          // responses come back as a JsonRpcMessage right
          // here, in which case we settle immediately.
          if (response === undefined) return;
          this.settle(id, response);
        })
        .catch((err) => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          reject(err as Error);
        });
    });
  }

  private notify(method: string, params: unknown) {
    if (!this.transport) return;
    void this.transport.send({
      jsonrpc: "2.0",
      method,
      params,
    });
  }
}
