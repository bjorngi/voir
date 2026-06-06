/**
 * The chat view: the message list, the model/mode drawer, and
 * the composer. Connects to the SSE stream to receive live
 * updates from the agent and to dispatch user actions
 * (send / cancel / set_model / set_mode).
 */
import { useEffect, useState } from "react";
import type { ChatLoaderData } from "~/routes/chat";
import type {
  AvailableModel,
  AvailableMode,
  ChatMessage,
} from "~/lib/chat-types";
import { streamUrl } from "~/lib/urls";
import { useAutoScroll, usePageVisible } from "~/lib/hooks";
import { MessageBubble } from "~/components/Message";
import { Composer } from "~/components/Composer";
import { ModelDrawer, usePendingSet } from "~/components/ModelDrawer";

type ChatData = Extract<ChatLoaderData, { k: "chat" }>;

export function ChatView({ data }: { data: ChatData }) {
  const { folder, session: initial } = data;
  const [messages, setMessages] = useState<ChatMessage[]>(initial.messages);
  const [busy, setBusy] = useState(initial.busy);
  // Number of prompts pi has queued for delivery between turns.
  // 0 means idle; >0 means a turn is in flight and additional
  // messages will be queued. The Composer uses this to render
  // a "Queued (n)" badge so the user knows their next message
  // won't be picked up immediately.
  const [queueDepth, setQueueDepth] = useState<number>(
    initial.queueDepth ?? 0,
  );
  // Tracks which model/mode values are mid-flight. The drawer
  // shows its controls in a pending state while a request is
  // outstanding, so the user can't fire a second change
  // before the first one lands.
  const pending = usePendingSet();
  // Drawer open state lives at the chat level (not in the
  // Composer) so the toggle button is rendered alongside the
  // model/mode controls. The CSS grid animation runs between
  // 0fr (closed) and 1fr (open) — see app.css for the
  // mechanism. The drawer is always mounted when there's
  // something to show, so the chevron affordance is never
  // hidden behind a tap.
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The model/mode pickers and slash-command palette all read
  // from the loader snapshot at first render. The agent
  // re-advertises the same data via notifications
  // (available_commands_update, current_model_update,
  // current_mode_update), but those arrive asynchronously — by
  // seeding the chat UI with the initial values we avoid a
  // flash of an empty picker.
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>(
    data.availableModels ?? [],
  );
  const [availableModes, setAvailableModes] = useState<AvailableMode[]>(
    data.availableModes ?? [],
  );
  const [currentModelId, setCurrentModelId] = useState<string | null>(
    data.currentModelId ?? null,
  );
  const [currentModeId, setCurrentModeId] = useState<string | null>(
    data.currentModeId ?? null,
  );
  const [commands, setCommands] = useState(data.availableCommands ?? []);
  const visible = usePageVisible();
  const scrollRef = useAutoScroll<HTMLDivElement>([messages, visible]);

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    const connect = () => {
      if (cancelled) return;
      es = new EventSource(streamUrl(folder.path, initial.id));

      // The server replays the current transcript as `snapshot`
      // events, then a `ready` event, then live updates as
      // `message` events. We accumulate snapshots and only
      // replace our state on `ready`, so the SSR transcript is
      // not double-counted. Live updates that arrive between
      // connect and `ready` are buffered and applied after.
      let snapshot: ChatMessage[] = [];
      let live: ChatMessage[] = [];
      let isLive = false;

      es.addEventListener("snapshot", (e) => {
        try {
          const msg = JSON.parse((e as MessageEvent).data) as ChatMessage;
          snapshot.push(msg);
        } catch {}
      });

      es.addEventListener("ready", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as {
            busy: boolean;
          };
          setBusy(data.busy);
        } catch {}
        // Authoritative state from the server replaces whatever
        // we had (SSR'd or stale). Then drain any live events
        // that arrived while we were still collecting the
        // snapshot.
        const drained = live;
        live = [];
        isLive = true;
        setMessages([...snapshot, ...drained]);
        snapshot = [];
      });

      es.addEventListener("message", (e) => {
        try {
          const msg = JSON.parse((e as MessageEvent).data) as ChatMessage;
          // Out-of-band control messages from the server (typed
          // payloads, not parsed text). The agent advertises
          // model/mode/command changes and queue depth via
          // these; they don't belong in the transcript — we
          // apply them to local state and drop them.
          if (msg.role === "system" && msg.kind === "control") {
            const c = msg.control;
            switch (c.type) {
              case "currentMode":
                setCurrentModeId(c.modeId);
                return;
              case "currentModel":
                setCurrentModelId(c.modelId);
                return;
              case "availableCommands":
                setCommands(c.commands);
                return;
              case "availableModels":
                setAvailableModels(c.models);
                return;
              case "availableModes":
                setAvailableModes(c.modes);
                return;
              case "queueDepth":
                setQueueDepth(c.depth);
                return;
            }
          }
          if (!isLive) {
            live.push(msg);
            return;
          }
          setMessages((prev) => apply(prev, msg, setBusy));
        } catch {}
      });

      es.addEventListener("error", () => {
        es?.close();
        es = null;
      });
    };
    connect();
    return () => {
      cancelled = true;
      es?.close();
    };
  }, [folder.path, initial.id]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="absolute inset-0 overflow-y-auto px-3 py-3 sm:px-4"
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {messages.map((m) => (
              <MessageBubble key={m.id} msg={m} />
            ))}
          </div>
        </div>
        {busy && <WorkingBorder />}
      </div>
      {/*
        The model/mode drawer is always mounted (when the
        agent has advertised at least one of model or mode)
        so the user has a visible chevron affordance to open
        it. The actual panel below the chevron animates in
        and out via CSS `grid-template-rows`; the chevron
        itself stays put.
      */}
      {(availableModels.length > 0 || availableModes.length > 0) && (
        <ModelDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onToggle={() => setDrawerOpen((v) => !v)}
          models={availableModels}
          modes={availableModes}
          currentModelId={currentModelId}
          currentModeId={currentModeId}
          pending={pending.pending}
          onPicked={async (kind, v) => {
            const action = kind === "model" ? "set_model" : "set_mode";
            await sendAction(initial.id, folder.path, action, v);
            if (kind === "model") setCurrentModelId(v);
            else setCurrentModeId(v);
            setDrawerOpen(false);
          }}
        />
      )}
      <Composer
        folder={folder.path}
        sessionId={initial.id}
        busy={busy}
        queueDepth={queueDepth}
        commands={commands}
        // Don't flip busy=true here — the server is the
        // source of truth. It will broadcast a `busy:true`
        // event when the prompt RPC actually starts the turn
        // (or queues for the next one), and a `busy:false`
        // when the turn ends. The send handler returns
        // immediately.
        onSent={() => {}}
        onCancel={() => {
          // Use the dedicated action endpoint rather than the
          // chat action (intent=cancel) so the contract for
          // "cancel a running turn" is a single well-known
          // URL.
          sendAction(initial.id, folder.path, "cancel").catch(() => {});
        }}
      />
    </div>
  );
}

/**
 * Dispatch a session-scoped action via the dedicated
 * `session/action` endpoint. Returns when the server has
 * acknowledged the action; we don't wait for the agent's
 * confirmation notification (the drawer is closed
 * optimistically, and the local state is updated by the
 * caller's setter).
 */
function sendAction(
  sessionId: string,
  folder: string,
  kind: "set_model" | "set_mode" | "cancel",
  value?: string,
): Promise<unknown> {
  return fetch(`/api/sessions/${sessionId}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder, kind, ...(value ? { value } : {}) }),
  }).then((r) => {
    if (!r.ok) throw new Error(`action ${kind} failed: ${r.status}`);
    return r.json();
  });
}

/**
 * Apply a single live update to the local message list. Text
 * and thought messages are matched by id (the server reuses
 * the streaming message's id for the whole turn), tool
 * messages by toolCallId. System busy events toggle the busy
 * flag and do not contribute to the transcript.
 */
function apply(
  prev: ChatMessage[],
  data: ChatMessage,
  setBusy: (b: boolean) => void,
): ChatMessage[] {
  if (data.role === "system" && data.kind === "busy") {
    setBusy(data.busy);
    return prev;
  }
  if (data.role === "system") return prev;
  if (data.kind === "text" || data.kind === "thought") {
    const i = prev.findIndex((m) => m.id === data.id);
    if (i !== -1) {
      const next = prev.slice();
      next[i] = data;
      return next;
    }
    return [...prev, data];
  }
  if (data.kind === "tool") {
    const i = prev.findIndex(
      (m) => m.kind === "tool" && m.toolCallId === data.toolCallId,
    );
    if (i !== -1) {
      const c = prev.slice();
      c[i] = data;
      return c;
    }
  }
  return [...prev, data];
}

// -----------------------------------------------------------------------
// WorkingBorder — a 2px amber bar pinned to the bottom edge
// of the messages area that sweeps left-to-right while the
// agent is producing a turn. Single source of truth for
// "agent is working"; we used to render a pulsing cursor
// inside each streaming message but that left stale cursors
// on every rehydrated transcript.
// -----------------------------------------------------------------------

function WorkingBorder() {
  // A single 2px-tall amber bar pinned to the bottom edge of
  // the messages area. The background is a narrow horizontal
  // gradient (transparent → amber → transparent) sized to
  // 25% of the bar width, and `border-slide` animates
  // background-position from -25% to 125%, so the highlight
  // enters from the left, sweeps across, and exits on the
  // right.
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] animate-border-slide"
      style={{
        background:
          "linear-gradient(90deg, transparent 0%, rgba(251, 191, 36, 0.95) 50%, transparent 100%)",
        backgroundSize: "25% 100%",
        backgroundRepeat: "no-repeat",
      }}
    />
  );
}
