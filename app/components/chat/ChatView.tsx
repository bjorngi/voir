/**
 * The chat view: the message list, the model/mode drawer, and
 * the composer. Connects to the SSE stream to receive live
 * updates from the agent and to dispatch user actions
 * (send / cancel / set_model / set_mode).
 */
import { useEffect, useRef, useState } from "react";
import type { ChatLoaderData } from "~/routes/chat";
import type {
  AvailableModel,
  AvailableMode,
  ChatMessage,
} from "~/lib/chat-types";
import { streamUrl, sessionUrl } from "~/lib/urls";
import { nextNarrationChunk } from "~/lib/narration";
import { useAutoScroll, usePageVisible } from "~/lib/hooks";
import type { Tts } from "~/lib/use-tts";
import { useVoiceMode } from "~/lib/use-voice";
import { useVoicePrefs, AUTO_SEND_MS } from "~/lib/voice-settings";
import { MessageBubble } from "~/components/Message";
import { Composer } from "~/components/Composer";
import { ModelDrawer, usePendingSet } from "~/components/ModelDrawer";
import { VoicePanel } from "./VoicePanel";

type ChatData = Extract<ChatLoaderData, { k: "chat" }>;

export function ChatView({
  data,
  tts,
  voiceActive,
  onVoiceActiveChange,
}: {
  data: ChatData;
  tts: Tts;
  voiceActive: boolean;
  onVoiceActiveChange: (v: boolean) => void;
}) {
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
  // Connection health of the SSE stream. `connected` is true once
  // the server has sent `ready` for the current connection;
  // `connReason` carries the last `fatal` message from the server
  // ("Agent offline…") while we keep retrying. The banner above the
  // composer renders from these.
  const [connected, setConnected] = useState(false);
  const [connReason, setConnReason] = useState<string | null>(null);
  const visible = usePageVisible();
  const scrollRef = useAutoScroll<HTMLDivElement>([messages, visible]);

  // Live-update stream. The server replays the current transcript
  // as `snapshot` events, then `ready`, then live `message` events —
  // the snapshot wholesale-replaces our state, so reconnecting at
  // any time is safe. That matters because mobile browsers kill
  // SSE sockets constantly (backgrounding, WiFi↔cellular handoff,
  // NAT timeouts) and the connection must survive all of it:
  //
  //   - on error we close and retry with exponential backoff
  //     (1s → 15s cap, with jitter), forever — the agent may be
  //     gone now and come back when its launcher re-registers;
  //   - on visibilitychange/online we retry immediately, because
  //     a backgrounded tab on iOS can lose the socket without an
  //     `error` event ever firing;
  //   - a watchdog force-reconnects if nothing (not even a
  //     keep-alive `ping`) has arrived for 45s, which catches
  //     half-open sockets the browser hasn't noticed are dead;
  //   - a `fatal` event from the server is informational (it says
  //     *why* the stream can't be served); we keep retrying.
  const everConnected = useRef(false);
  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    let attempts = 0;
    let connecting = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastActivity = Date.now();

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const markAlive = () => {
      lastActivity = Date.now();
    };

    const scheduleReconnect = () => {
      if (cancelled || connecting || timer !== null) return;
      const backoff = Math.min(15_000, 1000 * 2 ** Math.min(attempts, 4));
      attempts += 1;
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, backoff + Math.random() * 300);
    };

    const connect = () => {
      if (cancelled || connecting) return;
      connecting = true;
      clearTimer();
      es?.close();
      es = null;
      setConnected(false);
      setConnReason(null);
      markAlive();

      const sock = new EventSource(streamUrl(folder.path, initial.id));
      es = sock;

      // The server replays the current transcript as `snapshot`
      // events, then a `ready` event, then live updates as
      // `message` events. We accumulate snapshots and only
      // replace our state on `ready`, so the SSR transcript is
      // not double-counted. Live updates that arrive between
      // connect and `ready` are buffered and applied after.
      let snapshot: ChatMessage[] = [];
      let live: ChatMessage[] = [];
      let isLive = false;

      sock.addEventListener("snapshot", (e) => {
        markAlive();
        try {
          const msg = JSON.parse((e as MessageEvent).data) as ChatMessage;
          snapshot.push(msg);
        } catch {}
      });

      sock.addEventListener("ready", (e) => {
        markAlive();
        connecting = false;
        everConnected.current = true;
        attempts = 0;
        setConnected(true);
        setConnReason(null);
        try {
          const d = JSON.parse((e as MessageEvent).data) as {
            busy: boolean;
          };
          setBusy(d.busy);
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

      sock.addEventListener("message", (e) => {
        markAlive();
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

      // Server keep-alive: just liveness evidence for the
      // watchdog below (and it confirms the connection is
      // really open, not silently half-dead).
      sock.addEventListener("ping", markAlive);

      // The server couldn't serve this stream (folder not
      // registered, session unknown to the agent). Informational
      // only: the server ends the stream right after, the error
      // handler schedules the retry, and whatever went wrong may
      // fix itself (launcher re-registers, Voir restarts, the
      // agent comes back).
      sock.addEventListener("fatal", (e) => {
        markAlive();
        try {
          const d = JSON.parse((e as MessageEvent).data) as {
            message?: string;
          };
          setConnReason(d.message ?? "Disconnected — retrying…");
        } catch {
          setConnReason("Disconnected — retrying…");
        }
      });

      sock.addEventListener("error", () => {
        if (cancelled || es !== sock) return;
        connecting = false;
        sock.close();
        es = null;
        setConnected(false);
        scheduleReconnect();
      });
    };

    // Half-open-socket watchdog: mobile NATs can reap the TCP
    // connection without the browser ever firing `error`. If
    // nothing at all has arrived for 45s (the server pings every
    // 15s), the connection is dead from our side — force a
    // reconnect. Only relevant while we believe we're connected;
    // the retry path has its own timer.
    const watchdog = setInterval(() => {
      if (cancelled || es === null) return;
      if (Date.now() - lastActivity > 45_000) {
        connecting = false;
        es.close();
        es = null;
        setConnected(false);
        scheduleReconnect();
      }
    }, 10_000);

    // Coming back to the foreground (or regaining network): the
    // socket may have died while hidden without an error event —
    // iOS suspends the page and reaps its connections. If we're
    // not connected, reconnect right away instead of waiting out
    // the backoff timer (which was likely suspended mid-count).
    const onWake = () => {
      if (cancelled || document.hidden) return;
      if (!es) {
        // Forgive most of the backoff after a long absence; the
        // endpoint is probably fine and the phone just slept.
        attempts = Math.min(attempts, 2);
        connect();
      }
    };
    const onOnline = () => {
      if (cancelled || document.hidden) return;
      attempts = 0;
      if (!es) connect();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onOnline);

    connect();
    return () => {
      cancelled = true;
      clearTimer();
      clearInterval(watchdog);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onOnline);
      es?.close();
    };
  }, [folder.path, initial.id]);

  // ---------------------------------------------------------------------
  // Voice conversation mode: hands-free talk → transcribe →
  // auto-send → spoken reply → listen again. The header toggle
  // (ChatApp) flips `voiceActive`; the hook owns the mic capture,
  // the /api/voice streaming transport, and the phase machine.
  // When the hook exits on its own (edit tap, Esc, fatal error) it
  // syncs the flag back down.
  const [voiceDraft, setVoiceDraft] = useState<{
    text: string;
    seq: number;
  } | null>(null);
  // Voice panel settings (voice picker, narrate, auto-send),
  // persisted in localStorage.
  const {
    prefs: voicePrefs,
    setTtsVoice: setVoiceTtsVoice,
    setTtsSpeed: setVoiceTtsSpeed,
    setNarrate: setVoiceNarrate,
    setAutoSend: setVoiceAutoSend,
    setAutoListen: setVoiceAutoListen,
    setBargeIn: setVoiceBargeIn,
    setSounds: setVoiceSounds,
    setKeepAwake: setVoiceKeepAwake,
  } = useVoicePrefs();
  const voice = useVoiceMode({
    busy,
    ttsSpeaking: () => tts.speaking(),
    ttsCancel: () => tts.cancel(),
    autoSendMs: AUTO_SEND_MS[voicePrefs.autoSend],
    autoListen: voicePrefs.autoListen,
    sounds: voicePrefs.sounds,
    keepAwake: voicePrefs.keepAwake,
    bargeIn: voicePrefs.bargeIn,
    onSend: async (text) => {
      const body = new FormData();
      body.set("intent", "send");
      body.set("payload", JSON.stringify({ text, resources: [] }));
      const res = await fetch(sessionUrl(folder.path, initial.id), {
        method: "post",
        body,
      });
      if (!res.ok) throw new Error(`send failed: ${res.status}`);
    },
    onExitToEdit: (text) => setVoiceDraft({ text, seq: Date.now() }),
  });
  // The header toggle (ChatApp) owns the wanted-flag, the hook owns
  // reality. Both directions must be EDGE-triggered: level-triggered
  // logic made the two effects fight in the same commit — the
  // sync-down saw "!active && wanted" before the phase state from
  // start() landed, flipped the flag back off, and the next commit
  // tore the whole session down. Symptom: mic flash, no panel, a
  // dead-looking button. Edges fix it: start on the flag's rising
  // edge only, sync down only on the hook's active falling edge.
  const prevWantedRef = useRef(voiceActive);
  useEffect(() => {
    if (voiceActive && !prevWantedRef.current) {
      voice.start();
      // The Voice tap is the gesture that unlocks neural playback
      // — narration later in the turn needs the AudioContext
      // running by then (mobile suspends it without a gesture).
      tts.preparePlayback();
    }
    if (!voiceActive && prevWantedRef.current) voice.stop();
    prevWantedRef.current = voiceActive;
  }, [voiceActive, voice.start, voice.stop, tts.preparePlayback]);
  const prevActiveRef = useRef(voice.active);
  useEffect(() => {
    if (prevActiveRef.current && !voice.active && voiceActive) {
      onVoiceActiveChange(false); // the hook exited on its own
    }
    prevActiveRef.current = voice.active;
  }, [voice.active, voiceActive, onVoiceActiveChange]);

  // ---------------------------------------------------------------------
  // Spoken replies (TTS): narrate agent text messages as they
  // stream — sentence by sentence so the voice tracks the text
  // instead of waiting for the whole turn. Per-message progress is
  // kept in a ref keyed by message id, so reconnect snapshot
  // replacements and idempotent re-renders don't re-speak content.
  // The `tts` hook owns the toggle (header) and the utterance
  // queue; cancelling on user messages keeps turns from stacking
  // audio on top of each other. Voice conversation mode forces
  // narration on — a spoken conversation without spoken replies
  // isn't one.
  const spokenChars = useRef(new Map<string, number>());
  const ttsSeeded = useRef(false);
  const prevUserCount = useRef(0);
  useEffect(() => {
    if (!tts.enabled && !voice.active) return;
    // Seed on first run (or on first run after enabling): mark
    // everything currently on screen as already spoken so we
    // never narrate history — only content that arrives from here
    // on (including the tail of a turn that was streaming when
    // the toggle flipped).
    if (!ttsSeeded.current) {
      for (const m of messages) {
        if (m.role === "agent" && m.kind === "text") {
          spokenChars.current.set(m.id, (m.text ?? "").length);
        }
      }
      ttsSeeded.current = true;
      return;
    }
    // A new user message means a new turn — drop any still-queued
    // audio from the old one so replies can't overlap.
    const userCount = messages.reduce(
      (n, m) => n + (m.role === "user" ? 1 : 0),
      0,
    );
    if (userCount > prevUserCount.current) tts.cancel();
    prevUserCount.current = userCount;

    for (const m of messages) {
      if (m.role !== "agent" || m.kind !== "text") continue;
      const text = m.text ?? "";
      // Markdown-aware extraction (app/lib/narration.ts): fenced
      // code blocks are skipped outright — reading "backtick
      // backtick backtick" and code bytes aloud was the complaint —
      // and prose chunks arrive stripped of formatting (headings,
      // bullets, bold, link URLs, inline-code backticks…). Empty
      // chunks mean "only skipped code" — keep draining.
      let spoken = spokenChars.current.get(m.id) ?? 0;
      while (spoken < text.length) {
        const chunk = nextNarrationChunk(text, spoken, {
          final: !m.streaming,
        });
        if (!chunk) break;
        spoken = chunk.spoken;
        spokenChars.current.set(m.id, spoken);
        if (chunk.text) {
          tts.speak(chunk.text, {
            // Voice mode narrates per the panel's Narrate setting
            // and with the picker's voice; Read aloud uses the
            // default voice and the global toggle.
            force: voice.active && voicePrefs.narrate,
            voice: voicePrefs.ttsVoice ?? undefined,
            speed: voicePrefs.ttsSpeed,
          });
        }
      }
    }
  }, [messages, tts, voice.active, voicePrefs.narrate, voicePrefs.ttsVoice, voicePrefs.ttsSpeed]);

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
      {!connected && (
        <ConnectionBanner
          firstTime={!everConnected.current}
          reason={connReason}
        />
      )}
      {voice.active ? (
        /* Voice conversation mode owns the input area: the composer
           is replaced by the voice panel (mic orb, live transcript,
           contextual tap). The message list above stays live. */
        <VoicePanel
          voice={voice}
          tts={tts}
          prefs={voicePrefs}
          setTtsVoice={setVoiceTtsVoice}
          setTtsSpeed={setVoiceTtsSpeed}
          setNarrate={setVoiceNarrate}
          setAutoSend={setVoiceAutoSend}
          setAutoListen={setVoiceAutoListen}
          setBargeIn={setVoiceBargeIn}
          setSounds={setVoiceSounds}
          setKeepAwake={setVoiceKeepAwake}
        />
      ) : (
        <>
          {/* A voice-mode failure that ended the mode (mic denied,
              connection lost) is only visible while the panel is up —
              repeat the error above the composer so a dead-seeming
              button is never unexplained. Cleared on the next Voice
              tap (the hook clears on start). */}
          {!voice.active && voice.error && (
            <div className="px-3 pb-1 font-mono text-[11px] text-rose-400">
              voice: {voice.error}
            </div>
          )}
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
            initialAttach={data.attach}
            busy={busy}
            queueDepth={queueDepth}
            commands={commands}
            // Voice mode's tap-to-edit hands the transcript back
            // to the composer as a draft (seq makes it re-fire).
            injectText={voiceDraft ?? undefined}
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
        </>
      )}
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
// ConnectionBanner — shown while the SSE stream is not connected.
// The client keeps retrying with backoff (see the effect above), so
// this is reassurance, not an error the user has to act on. Never
// blocks the composer: messages sent while disconnected queue on
// the server as usual, and the transcript catches up on reconnect.
// -----------------------------------------------------------------------

function ConnectionBanner({
  firstTime,
  reason,
}: {
  firstTime: boolean;
  reason: string | null;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="shrink-0 border-t border-neutral-800 bg-neutral-900/70 px-3 py-1.5 font-mono text-[11px] text-neutral-400"
    >
      {reason ??
        (firstTime ? "Connecting…" : "Connection lost — reconnecting…")}
    </div>
  );
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
