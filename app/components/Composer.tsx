import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { SlashCommand } from "~/lib/chat-types";
import { appendFinal } from "~/lib/dictation";
import { useSpeechRecognition } from "~/lib/use-speech-recognition";
import { sessionUrl } from "~/lib/urls";

/**
 * Sticky-bottom composer. Mobile-first:
 *  - full-width
 *  - 44px+ tap targets
 *  - Enter to send, Shift+Enter for newline
 *  - / opens a slash-command popover
 *  - @ opens a fuzzy file picker; selecting inserts "@<path>" and
 *    attaches a resource_link content block to the next message
 *  - the model/mode chip opens a drawer above the textarea for
 *    switching the session's model or mode without leaving the
 *    chat
 *
 * Slash commands are sent as plain text; the agent expands
 * `/name foo` against its advertised `available_commands_update`
 * list and substitutes `$1`/`$@` from the rest of the text.
 * Voir does no command expansion itself — the picker is
 * purely UX so the user can discover available commands.
 */

interface Mention {
  /** Path relative to the folder, e.g. "src/foo.ts". Unique key. */
  key: string;
  /** Path relative to the folder, displayed in the text. */
  relPath: string;
  /** File basename, used for the @-token shorthand. */
  name: string;
  /** Best-effort MIME type from the file extension. */
  mimeType?: string;
  /** Bytes; populated lazily. */
  size?: number;
}

const MIME: Record<string, string> = {
  ts: "text/typescript",
  tsx: "text/typescript",
  js: "text/javascript",
  jsx: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  json: "application/json",
  jsonc: "application/json",
  md: "text/markdown",
  mdx: "text/markdown",
  py: "text/x-python",
  rb: "text/x-ruby",
  rs: "text/x-rust",
  go: "text/x-go",
  java: "text/x-java",
  kt: "text/x-kotlin",
  swift: "text/x-swift",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  hpp: "text/x-c++",
  cs: "text/x-csharp",
  php: "text/x-php",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  zsh: "text/x-shellscript",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  scss: "text/x-scss",
  sass: "text/x-sass",
  less: "text/x-less",
  xml: "application/xml",
  svg: "image/svg+xml",
  yaml: "application/x-yaml",
  yml: "application/x-yaml",
  toml: "application/toml",
  sql: "application/sql",
  txt: "text/plain",
};

function mimeFor(path: string): string | undefined {
  const i = path.lastIndexOf(".");
  if (i < 0) return undefined;
  return MIME[path.slice(i + 1).toLowerCase()];
}

export function Composer({
  folder,
  sessionId,
  busy,
  onSent,
  onCancel,
  queueDepth = 0,
  commands: initialCommands = [],
}: {
  folder: string;
  sessionId: string;
  busy: boolean;
  onSent?: () => void;
  onCancel?: () => void;
  /**
   * Number of prompts the agent has queued for delivery
   * between turns. The Composer shows a "Queued (n)" badge
   * while this is > 0, so the user knows their next message
   * will be picked up after the current turn (or after the
   * already-queued ones) rather than immediately.
   */
  queueDepth?: number;
  /**
   * Initial set of slash commands, snapshotted from the chat
   * loader. The chat keeps the live copy (it gets updated by
   * `available_commands_update` notifications) and re-passes
   * it as `commands` on every render. We keep a local
   * `commands` state so the slash menu still works if the
   * parent never re-renders (e.g. while a turn is in flight).
   */
  commands?: SlashCommand[];
}) {
  const fetcher = useFetcher<{ error?: string; ok?: boolean }>();
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<Mention[]>([]);
  // Seed the slash-command list from the loader snapshot; the
  // chat will push live updates via the EventSource. We don't
  // need to fetch this ourselves — the loader has it.
  const [commands, setCommands] = useState<SlashCommand[]>(initialCommands);
  useEffect(() => {
    setCommands(initialCommands);
  }, [initialCommands]);
  const [files, setFiles] = useState<string[]>([]);
  const [fileQuery, setFileQuery] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Speech-to-text dictation: hold the Send button, talk,
  // release — the transcript lands in the composer as a draft
  // (never auto-sent: recognition makes mistakes and an agent
  // turn is expensive, so you review before sending). The
  // recognizer is transport-only (see use-speech-recognition);
  // while holding, finals accumulate in a ref and the interim
  // preview lives in `interim` state for the overlay. Everything
  // commits exactly once in onStop, when the session really ends.
  const [dictating, setDictating] = useState(false);
  // Mic stopped on release but the recognizer is still flushing
  // its final transcript — the overlay switches from "listening"
  // to a transcribing state instead of pretending nothing is
  // happening for the ~a second the flush can take.
  const [finishing, setFinishing] = useState(false);
  const [interim, setInterim] = useState("");
  const finalRef = useRef("");
  const interimRef = useRef("");
  const mic = useSpeechRecognition({
    onInterim: (t) => {
      interimRef.current = t;
      setInterim(t);
    },
    // Accumulate with appendFinal (overlap-deduping): recognizers
    // re-deliver finals — the same segment twice, or the whole
    // transcript so far — and the session-restart that keeps long
    // dictation alive re-captures the odd word. Blind appending
    // made words repeat many times over (see app/lib/dictation.ts
    // for the failure modes and the heuristics).
    onFinal: (t) => {
      finalRef.current = appendFinal(finalRef.current, t);
      interimRef.current = "";
      setInterim("");
    },
    onStop: () => {
      // Fires once per dictation (restarts don't count). Any final
      // flushed by stop() has been delivered by now; commit finals
      // plus whatever interim never finalized (e.g. "aborted").
      setDictating(false);
      setFinishing(false);
      const transcript = appendFinal(finalRef.current, interimRef.current).trim();
      finalRef.current = "";
      interimRef.current = "";
      setInterim("");
      if (transcript) setText((prev) => appendFinal(prev, transcript));
      requestAnimationFrame(() => ref.current?.focus());
    },
  });

  // Hold-to-talk state machine for the Send button. Short press =
  // send (as before). Holding ≥ 250ms = dictation: overlay pops
  // up, mic starts; release stops it and the transcript becomes a
  // draft. Pointer capture ensures release outside the button
  // still counts; cancel (incoming call, system gesture) commits
  // what was said so far rather than dropping it.
  const HOLD_MS = 250;
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdingRef = useRef(false);

  const startDictation = () => {
    finalRef.current = "";
    interimRef.current = "";
    setInterim("");
    setFinishing(false);
    setDictating(true);
    // Collapse the on-screen keyboard — the dictation popup owns
    // the screen while you talk, and there's no reason the
    // keyboard should eat half of it. Focus (and the keyboard)
    // come back on commit, ready to edit the transcript.
    ref.current?.blur();
    mic.start();
  };

  const stopDictation = () => {
    // The recognizer takes a moment to flush its final after
    // stop() — switch the overlay to the transcribing state while
    // it lands instead of silently stalling.
    setFinishing(true);
    mic.stop(); // transcript commits in onStop
  };

  const clearHold = () => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };

  const onSendPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    // Ignore second fingers while a dictation or its final flush
    // is in flight — a second hold would reset the transcript
    // accumulator mid-commit.
    if (!mic.supported || dictating || finishing) return;
    e.preventDefault(); // no focus steal, no tap highlight
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    holdingRef.current = false;
    clearHold();
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      holdingRef.current = true;
      startDictation();
    }, HOLD_MS);
  };

  const onSendPointerUp = () => {
    clearHold();
    if (holdingRef.current) {
      // This is the release of the finger that started the hold.
      holdingRef.current = false;
      stopDictation();
      return;
    }
    if (dictating || finishing) return; // stray tap during hold/flush
    send();
  };

  const onSendPointerCancel = () => {
    clearHold();
    if (holdingRef.current) {
      holdingRef.current = false;
      stopDictation(); // commits what was said instead of dropping it
    }
  };

  // Load file index on first @ and on folder change
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/folder-files?folder=${encodeURIComponent(folder)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.files) setFiles(d.files);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [folder]);

  // Detect a currently-active @mention query at the caret.
  // Looks back from the caret for an `@` that isn't preceded by
  // something that would make it not-a-mention (whitespace or BOL).
  const activeQuery = useMemo(() => {
    const ta = ref.current;
    if (!ta) return null;
    const caret = ta.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    // Find the last whitespace-or-bol before the caret
    let i = before.length - 1;
    while (i >= 0 && !/\s/.test(before[i])) i--;
    const start = i + 1;
    const token = before.slice(start);
    if (!token.startsWith("@")) return null;
    // Don't trigger on @ inside an email-like or after a quote
    return { query: token.slice(1), start, end: caret };
  }, [text]);

  // Show @-menu if we have a live query
  useEffect(() => {
    if (activeQuery && !slashQuery) {
      setFileQuery(activeQuery.query);
      setMenuIndex(0);
    } else {
      setFileQuery(null);
    }
  }, [activeQuery, slashQuery]);

  // Detect a slash command at the start of the text
  useEffect(() => {
    if (text.startsWith("/") && !text.includes(" ")) {
      setSlashQuery(text.slice(1));
      setMenuIndex(0);
    } else {
      setSlashQuery(null);
    }
  }, [text]);

  // Filter file list
  const fileMatches = useMemo(() => {
    if (fileQuery === null) return [];
    const q = fileQuery.toLowerCase();
    if (!q) return files.slice(0, 50);
    // Cheap fuzzy: every char of q must appear in order in the path.
    // Prefer matches near the basename.
    const out: Array<{ path: string; score: number }> = [];
    for (const p of files) {
      const lower = p.toLowerCase();
      let qi = 0;
      let lastMatch = -1;
      let ok = true;
      for (let pi = 0; pi < lower.length && qi < q.length; pi++) {
        if (lower[pi] === q[qi]) {
          if (lastMatch === -1) lastMatch = pi;
          qi++;
        }
      }
      if (qi === q.length) {
        // Score: basename match wins, then earlier match, then shorter path.
        const base = p.slice(p.lastIndexOf("/") + 1).toLowerCase();
        const baseHit = base.includes(q) ? 100 : 0;
        const firstHit = lastMatch;
        const len = -p.length;
        out.push({ path: p, score: baseHit - firstHit + len });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 30).map((x) => x.path);
  }, [files, fileQuery]);

  // Filter slash commands
  const slashMatches = useMemo(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.name.toLowerCase().startsWith(q));
  }, [commands, slashQuery]);

  // Insert a mention at the active @-token
  function pickFile(path: string) {
    if (!activeQuery) return;
    const name = path.slice(path.lastIndexOf("/") + 1);
    // Strip the `@query` token, then insert `@name ` (or just `@name`
    // if no trailing space would otherwise remain).
    const before = text.slice(0, activeQuery.start);
    const after = text.slice(activeQuery.end);
    const inserted = `@${name} `;
    const next = before + inserted + after;
    setText(next);
    setMentions((m) =>
      m.some((x) => x.key === path)
        ? m
        : [
            ...m,
            {
              key: path,
              relPath: path,
              name,
              mimeType: mimeFor(path),
            },
          ],
    );
    // Move caret to after the inserted token
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      const pos = before.length + inserted.length;
      el.setSelectionRange(pos, pos);
      el.focus();
    });
  }

  function pickCommand(cmd: SlashCommand) {
    setText(`/${cmd.name} `);
    setSlashQuery(null);
    requestAnimationFrame(() => ref.current?.focus());
  }

  function send() {
    if (dictating) stopDictation();
    if (!text.trim() && mentions.length === 0) return;
    // The server accepts new messages while a turn is running;
    // pi-acp will queue them for delivery between turns and
    // broadcast a `queueDepth` update so the UI can show a
    // "Queued (n)" badge. We send the form regardless of
    // `busy` — the only state where the server would reject
    // is if the session doesn't exist, which we can't get
    // into from the chat UI.
    const payload = { text: text.trim(), resources: mentions };
    setText("");
    setMentions([]);
    onSent?.();
    fetcher.submit(
      { intent: "send", payload: JSON.stringify(payload) },
      {
        method: "post",
        action: sessionUrl(folder, sessionId),
      },
    );
  }

  // Allow user to backspace an @token and remove the attachment
  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    setText(next);
    // Drop mentions whose @-token was deleted entirely
    setMentions((ms) =>
      ms.filter((m) => next.includes(`@${m.name}`)),
    );
  }

  const showSlashMenu = slashQuery !== null && slashMatches.length > 0;
  const showFileMenu = fileQuery !== null && fileMatches.length > 0;
  const showAnyMenu = showSlashMenu || showFileMenu;

  return (
    <div className="relative shrink-0 border-t border-neutral-800 bg-neutral-950/80 px-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-2 backdrop-blur">
      {mentions.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5 px-2">
          {mentions.map((m) => (
            <span
              key={m.key}
              className="inline-flex items-center gap-1.5 bg-neutral-800 px-2 py-0.5 font-mono text-[11px] text-neutral-300"
            >
              <span className="text-neutral-500">@</span>
              {m.relPath}
              <button
                type="button"
                onClick={() => {
                  setMentions((ms) => ms.filter((x) => x.key !== m.key));
                  setText((t) => t.replace(`@${m.name}`, "").replace(/  +/g, " "));
                }}
                className="text-neutral-500 active:text-neutral-200"
                aria-label={`Remove @${m.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {busy && (
        <div
          className="mb-1.5 flex items-center gap-2 px-2 font-mono text-[11px] text-neutral-500"
          aria-live="polite"
        >
          {queueDepth > 0 ? (
            <span className="text-amber-300" data-testid="queue-depth">
              {queueDepth} queued
            </span>
          ) : (
            <span aria-hidden="true">​</span>
          )}
        </div>
      )}

      {dictating && (
        <div
          role="status"
          aria-live="polite"
          className="absolute bottom-full left-2 right-2 mb-1 border border-amber-400/40 bg-neutral-900 p-3 shadow-2xl"
        >
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-amber-300">
            <span
              aria-hidden="true"
              className={
                "inline-block h-2 w-2 rounded-full bg-amber-400 " +
                (finishing ? "opacity-60" : "animate-pulse")
              }
            />
            {finishing ? "Transcribing…" : "Listening — release to insert"}
            {mic.error && (
              <span className="ml-auto normal-case tracking-normal text-rose-400">
                {mic.error}
              </span>
            )}
          </div>
          <div className="mt-1.5 min-h-6 font-mono text-[14px] leading-relaxed text-neutral-100">
            {/* Display via appendFinal too: a restarted session's
                interim can re-capture the tail of what's already
                committed — dedupe live so the popup never shows
                the same words twice. */}
            {appendFinal(finalRef.current, interim) || (
              <span className="text-neutral-500">…</span>
            )}
          </div>
        </div>
      )}

      {showAnyMenu && (
        <div className="absolute bottom-full left-2 right-2 mb-1 max-h-64 overflow-auto border border-neutral-800 bg-neutral-900 shadow-2xl">
          {showFileMenu &&
            fileMatches.map((p, i) => (
              <button
                key={p}
                type="button"
                onClick={() => pickFile(p)}
                onMouseEnter={() => setMenuIndex(i)}
                className={
                  "flex w-full items-baseline gap-3 px-3 py-1.5 text-left text-sm active:bg-neutral-800 " +
                  (i === menuIndex ? "bg-neutral-800" : "")
                }
              >
                <span className="font-mono text-[12px] text-neutral-200">
                  {p.slice(p.lastIndexOf("/") + 1)}
                </span>
                <span className="flex-1 truncate font-mono text-[11px] text-neutral-500">
                  {p.slice(0, p.lastIndexOf("/") + 1) || "/"}
                </span>
              </button>
            ))}
          {!showFileMenu &&
            slashMatches.map((c, i) => (
              <button
                key={c.name}
                type="button"
                onClick={() => pickCommand(c)}
                onMouseEnter={() => setMenuIndex(i)}
                className={
                  "flex w-full items-start gap-3 px-3 py-2.5 text-left text-sm active:bg-neutral-800 " +
                  (i === menuIndex ? "bg-neutral-800" : "")
                }
              >
                <span className="font-mono text-neutral-200">/{c.name}</span>
                <span className="flex-1 truncate text-neutral-500">{c.description}</span>
              </button>
            ))}
        </div>
      )}

      {fetcher.data?.error && (
        <div className="mb-2 px-2 text-xs text-rose-400">{fetcher.data.error}</div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <textarea
          ref={ref}
          value={text}
          onChange={onChange}
          onKeyDown={(e) => {
            if (showAnyMenu) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                const len = showFileMenu ? fileMatches.length : slashMatches.length;
                setMenuIndex((i) => Math.min(i + 1, len - 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMenuIndex((i) => Math.max(i - 1, 0));
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                if (showFileMenu) {
                  if (fileMatches.length > 0) pickFile(fileMatches[menuIndex]);
                } else {
                  if (slashMatches.length > 0) pickCommand(slashMatches[menuIndex]);
                }
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                if (showFileMenu) setFileQuery(null);
                else setSlashQuery(null);
                return;
              }
            }
            // On desktop the Stop button is hidden; the Esc
            // key is the keyboard shortcut for cancelling a
            // running turn. Mobile users still have the on-
            // screen Stop button. We only fire `onCancel`
            // when a turn is actually in flight so an idle
            // Esc press doesn't trigger a stray request.
            if (e.key === "Escape" && busy) {
              e.preventDefault();
              onCancel?.();
              return;
            }
            // Enter inserts a newline (so mobile users can do
            // multi-line messages naturally). ⌘+Enter / Ctrl+Enter
            // sends. The hint is shown in the placeholder.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            busy
              ? "Type to queue… (@ attach, / commands, Esc to stop — hold Send to dictate)"
              : "Message…  (@ attach, / commands, ⌘+Enter to send — hold Send to dictate)"
          }
          className="scrollbar-hide composer-textarea flex-1 resize-none border border-neutral-800 bg-neutral-900 px-4 py-2.5 font-mono text-[14px] text-neutral-100 placeholder-neutral-500 outline-none focus:border-neutral-600"
        />
        <div className="flex shrink-0 items-stretch gap-2 sm:contents">
          {busy && (
            <button
              type="button"
              onClick={onCancel}
              className="h-11 flex-1 border border-rose-400/60 bg-transparent px-3 text-xs font-semibold uppercase tracking-wider text-rose-300 transition-colors active:bg-rose-500/10 sm:hidden sm:flex-none sm:px-5 sm:text-sm"
              title="Stop the current turn and clear queued messages (Esc)"
            >
              Stop
            </button>
          )}
          {/* Hold-to-talk lives on Send: press-and-hold (≥250ms)
              starts dictation (if the browser supports STT), release
              stops it and the transcript becomes a reviewable draft;
              a short press sends as before. Never `disabled` —
              pointer events must flow for the hold gesture — so the
              empty state dims via classes instead. */}
          <button
            type="button"
            onPointerDown={onSendPointerDown}
            onPointerUp={onSendPointerUp}
            onPointerCancel={onSendPointerCancel}
            onContextMenu={(e) => {
              // Long-press otherwise pops text-selection/callout UI
              // over the dictation overlay on Android.
              if (mic.supported) e.preventDefault();
            }}
            onClick={(e) => {
              // Pointer paths send on pointerup; keyboard activation
              // (Tab + Enter/Space) goes through click with detail 0.
              if (e.detail === 0) send();
            }}
            aria-label={dictating ? "Dictating — release to insert" : "Send message — hold to dictate"}
            className={
              "h-11 flex-1 select-none border px-5 text-sm font-semibold uppercase tracking-wider [touch-action:manipulation] transition-colors active:bg-white/10 sm:hidden sm:flex-none " +
              (dictating
                ? "border-amber-400/70 bg-transparent text-amber-300 animate-pulse"
                : busy
                  ? "border-amber-400/70 bg-transparent text-amber-300"
                  : text.trim() || mentions.length > 0
                    ? "border-white bg-transparent text-white"
                    : "border-neutral-700 bg-transparent text-neutral-600 active:bg-transparent")
            }
          >
            {dictating ? (finishing ? "Transcribing…" : "Listening…") : busy ? "Queue" : "Send"}
          </button>
        </div>
    </div>
    </div>
  );
}
