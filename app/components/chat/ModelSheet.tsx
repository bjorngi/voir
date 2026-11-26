/**
 * ModelSheet — model / mode / fence as a bottom sheet.
 *
 * This used to be an inline drawer that expanded above the composer. On a
 * phone pane (416×657) that was the wrong shape twice over: expanding pushed
 * the transcript up by the panel's height, and the panel's contents (three
 * selects, a vision note, a maintenance row) had to fit a 40px-tall band of
 * layout rather than the screen.
 *
 * A sheet fixes both: it is an overlay, so opening it never reflows the
 * conversation, and it can be as tall as the content needs. It is opened from
 * the composer's grip strip (tap or swipe up) and dismissed by tapping the
 * backdrop, the ✕, Esc, or swiping down on its header — the same gesture
 * vocabulary in both directions.
 */
import { useEffect, useRef, useState } from "react";
import {
  modelVision,
  type AvailableMode,
  type AvailableModel,
} from "~/lib/chat-types";

export type ModelSheetProps = {
  open: boolean;
  onClose: () => void;
  models: AvailableModel[];
  modes: AvailableMode[];
  presets?: string[];
  currentModelId: string | null;
  currentModeId: string | null;
  currentPreset: string | null;
  presetPending: boolean;
  pending: Set<string>;
  onPicked?: (kind: "model" | "mode", value: string) => void;
  onPickPreset?: (preset: string) => void;
  onClearCache?: () => Promise<unknown>;
  cacheClearing?: boolean;
};

export function ModelSheet(props: ModelSheetProps) {
  const { open, onClose } = props;
  const [shown, setShown] = useState(false);
  const [dragY, setDragY] = useState(0);
  const drag = useRef<{ start: number; active: boolean }>({
    start: 0,
    active: false,
  });
  const panel = useRef<HTMLDivElement | null>(null);

  // Slide in on mount (one frame later, so the transition has a start value)
  // and reset the drag offset whenever the sheet is re-opened.
  useEffect(() => {
    if (!open) return;
    setDragY(0);
    const id = requestAnimationFrame(() => setShown(true));
    return () => {
      cancelAnimationFrame(id);
      setShown(false);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Focus the first control so a keyboard user lands inside the sheet;
    // restore happens in the caller (the grip button).
    const t = setTimeout(() => {
      panel.current?.querySelector<HTMLElement>("select")?.focus();
    }, 60);
    return () => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open) return null;

  const hasModels = props.models.length > 0;
  const hasModes = props.modes.length > 0;
  const hasPresets = (props.presets ?? []).length > 0;
  const empty = !hasModels && !hasModes && !hasPresets;
  const currentVision = props.currentModelId
    ? modelVision(
        props.models.find((m) => m.modelId === props.currentModelId) ?? {
          modelId: props.currentModelId,
        },
      )
    : undefined;
  const visionCount = props.models.filter((m) => modelVision(m) === true).length;

  const close = () => {
    setShown(false);
    // Let the slide-out finish before unmounting.
    setTimeout(onClose, 140);
  };

  const endDrag = () => {
    if (!drag.current.active) return;
    drag.current.active = false;
    if (dragY > 70) close();
    else setDragY(0);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Close model, mode and fence"
        onClick={close}
        className="absolute inset-0 bg-black/60"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Model, mode and fence"
        className={
          // A sheet, not a wall: capped to a comfortable column so it does
          // not become 1728px of empty at the bottom of a laptop screen.
          "relative mx-auto w-full max-w-md max-h-[80vh] overflow-y-auto rounded-t-xl border border-b-0 border-neutral-800 bg-neutral-950 pb-[max(env(safe-area-inset-bottom),0.5rem)] shadow-2xl transition-transform duration-150 ease-out"
        }
        style={{
          transform: `translateY(${shown ? dragY : 400}px)`,
          transitionDuration: drag.current.active ? "0ms" : undefined,
        }}
      >
        {/* Header = the drag handle: swipe down to dismiss. */}
        <div
          className="sticky top-0 z-10 select-none bg-neutral-950/95 pt-2 backdrop-blur"
          onPointerDown={(e) => {
            drag.current = { start: e.clientY, active: true };
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.current.active) return;
            setDragY(Math.max(0, e.clientY - drag.current.start));
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="mx-auto h-1 w-9 rounded-full bg-neutral-700" />
          <div className="mt-0.5 flex items-center justify-between px-2 pb-0.5">
            <span className="font-mono text-[11px] uppercase tracking-widest text-neutral-500">
              Model · mode · fence
            </span>
            <button
              type="button"
              onClick={close}
              aria-label="Close model, mode and fence"
              className="-mr-1 inline-flex h-8 w-8 items-center justify-center rounded text-neutral-400 active:bg-neutral-800"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="5" y1="5" x2="19" y2="19" />
                <line x1="19" y1="5" x2="5" y2="19" />
              </svg>
            </button>
          </div>
        </div>

        {empty ? (
          <div className="px-3 pb-3 text-[12px] text-neutral-500">
            The agent didn't advertise any models or modes, and there is no
            supervisor preset (fence command) to switch it to.
          </div>
        ) : (
          // Stacked on a phone: the sheet is an overlay, so vertical room is
          // free — and two 160px columns clip "Cheery 1 (mock) · vision" to
          // "… · visic".
          <div className="flex flex-col gap-1.5 px-2 pb-1 sm:flex-row sm:flex-wrap">
            {hasModels && (
              <NativeSelect
                label="Model"
                value={props.currentModelId ?? ""}
                disabled={props.pending.size > 0}
                options={props.models.map((m) => ({
                  value: m.modelId,
                  label:
                    (m.name ?? m.modelId) +
                    (modelVision(m) === true ? " · vision" : ""),
                }))}
                onChange={(v) => props.onPicked?.("model", v)}
              />
            )}
            {hasModes && (
              <NativeSelect
                label="Mode"
                value={props.currentModeId ?? ""}
                disabled={props.pending.size > 0}
                options={props.modes.map((m) => ({
                  value: m.id,
                  label: m.name ?? m.id,
                }))}
                onChange={(v) => props.onPicked?.("mode", v)}
              />
            )}
            {hasPresets && (
              <NativeSelect
                label="Fence"
                value={props.currentPreset ?? ""}
                disabled={props.presetPending}
                options={(props.presets ?? []).map((p) => ({
                  value: p,
                  label: p === props.currentPreset ? `${p} (running)` : p,
                }))}
                onChange={(v) => props.onPickPreset?.(v)}
              />
            )}
          </div>
        )}

        {hasModels && currentVision !== undefined && (
          <div
            className={
              "px-2 pb-1.5 font-mono text-[10px] " +
              (currentVision ? "text-emerald-400" : "text-amber-300")
            }
            data-testid="drawer-vision"
          >
            {currentVision
              ? "Images ✓ — this model sees attached images"
              : `Images ✗ — this model can't see them (pick one marked · vision; ${visionCount} of ${props.models.length} qualify)`}
          </div>
        )}

        {props.onClearCache && (
          <div className="border-t border-neutral-800">
            <button
              type="button"
              onClick={() => void props.onClearCache?.()}
              disabled={props.cacheClearing}
              className="block w-full px-2 py-2 text-left font-mono text-[10px] text-neutral-400 active:bg-neutral-800 disabled:opacity-60"
            >
              {props.cacheClearing
                ? "Clearing — re-syncing from agent truth…"
                : "Clear cache — re-sync this agent from truth"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** A native <select> with a small uppercase label above it. */
function NativeSelect({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-0.5 sm:flex-1 sm:basis-40">
      <span className="font-mono text-[10px] uppercase tracking-widest text-neutral-500">
        {label}
      </span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full appearance-none border border-neutral-800 bg-neutral-900 px-2 font-mono text-[13px] text-neutral-100 outline-none focus:border-neutral-600 disabled:opacity-60"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Tracks which model/mode values are mid-flight, so the sheet can mark them
 * pending. Keyed by value string (unique within a section).
 */
export function usePendingSet() {
  const [pending, setPending] = useState<Set<string>>(new Set());
  return {
    pending,
    add: (v: string) =>
      setPending((s) => {
        if (s.has(v)) return s;
        const n = new Set(s);
        n.add(v);
        return n;
      }),
    remove: (v: string) =>
      setPending((s) => {
        if (!s.has(v)) return s;
        const n = new Set(s);
        n.delete(v);
        return n;
      }),
  };
}
