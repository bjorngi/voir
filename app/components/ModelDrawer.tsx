import { useEffect, useState } from "react";
import type { AvailableModel, AvailableMode } from "~/lib/chat-types";

/**
 * Inline panel for switching the session's active model and mode.
 *
 * The panel sits in a CSS grid track whose row size animates
 * between `0fr` (closed) and `1fr` (open). This is the only
 * way to animate from a collapsed state to an intrinsic content
 * height without hard-coding pixel heights — see the
 * `.drawer-grid` rule in `app.css` for the mechanism.
 *
 * Layout: a chevron toggle at the top of the panel (visible
 * whenever the panel is visible), and below it a row of two
 * native `<select>` elements (one for model, one for mode).
 * The selects are full-width side-by-side; on a narrow
 * viewport the user picks them naturally in either order.
 *
 * The chevron button is part of the panel rather than a
 * separate affordance on the chat/composer divider, so it
 * animates in and out together with the panel — there's no
 * stray button left behind on the chat when the drawer is
 * closed.
 *
 * Picking a value from a native select fires `onPicked`
 * (with `kind: "model" | "mode"` and the new value); the
 * parent is expected to send the corresponding RPC and
 * close the drawer on success.
 */
export function ModelDrawer({
  open,
  onClose,
  onToggle,
  models,
  modes,
  currentModelId,
  currentModeId,
  pending,
  onPicked,
}: {
  open: boolean;
  /** Called when the user wants to close the drawer (Esc,
   * picking a value, or tapping the chevron while it's
   * open). The parent clears its `open` flag in response. */
  onClose: () => void;
  /** Called when the user taps the chevron. The parent uses
   * this to flip the drawer's open state. The chevron is
   * always visible (it sits outside the clipped panel) so
   * the user has a discoverable affordance to open the
   * drawer in the first place. */
  onToggle: () => void;
  models: AvailableModel[];
  modes: AvailableMode[];
  currentModelId: string | null;
  currentModeId: string | null;
  /** While an action is in flight (set_model / set_mode), the
   * corresponding control is shown in a pending state and
   * picking a different value is no-op'd. A Set of pending
   * keys lets the user change model and mode in quick
   * succession without flicker. */
  pending: Set<string>;
  onPicked?: (kind: "model" | "mode", value: string) => void;
}) {
  // Escape closes the drawer
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const hasModels = models.length > 0;
  const hasModes = modes.length > 0;
  const empty = !hasModels && !hasModes;

  return (
    <div>
      {/* Chevron toggle. Sits OUTSIDE the clipped grid
          panel so it's always visible — otherwise the user
          has no discoverable affordance to open the drawer
          in the first place. The arrow direction signals
          the current state: up means "open me", down means
          "close me".

          The button has its own left and top borders (same
          color as the panel's frame) so it reads as a
          connected, slightly raised affordance rather than
          a floating element. The bg matches the panel so
          the border line is the only thing visually
          separating them. */}
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={
            open ? "Close model and mode" : "Open model and mode"
          }
          title={open ? "Close model and mode" : "Open model and mode"}
          className="inline-flex h-7 w-7 items-center justify-center border-l border-t border-r border-neutral-800 bg-neutral-950 text-base text-neutral-200 active:bg-neutral-800"
        >
          <span aria-hidden="true" className="font-mono leading-none">
            {open ? "▾" : "▴"}
          </span>
        </button>
      </div>
      {/* The panel below the chevron. Wrapped in a single-
          row CSS grid whose track animates between 0fr
          (collapsed) and 1fr (natural content height) on
          the data-open attribute. The inner `.drawer-panel`
          clips its overflow so the content slides rather
          than appearing mid-animation. Full width so the
          drawer spans edge-to-edge. */}
      <div className="drawer-grid" data-open={open ? "true" : "false"}>
        <div className="drawer-panel">
          <div className="border border-neutral-800 bg-neutral-950 shadow-2xl">
            {empty ? (
              <div className="px-3 pb-3 text-[12px] text-neutral-500">
                The agent didn't advertise any models or modes for this
                session.
              </div>
            ) : (
              <div className="flex gap-2 p-2">
                {hasModels && (
                  <NativeSelect
                    label="Model"
                    value={currentModelId ?? ""}
                    disabled={pending.size > 0}
                    options={models.map((m) => ({
                      value: m.modelId,
                      label: m.name ?? m.modelId,
                    }))}
                    onChange={(v) => onPicked?.("model", v)}
                  />
                )}
                {hasModes && (
                  <NativeSelect
                    label="Mode"
                    value={currentModeId ?? ""}
                    disabled={pending.size > 0}
                    options={modes.map((m) => ({
                      value: m.id,
                      label: m.name ?? m.id,
                    }))}
                    onChange={(v) => onPicked?.("mode", v)}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A native <select> wrapped in a small label. The label sits
 * above the select, full-width. We use the browser's native
 * picker (rather than a custom popover) so the user gets the
 * platform's keyboard navigation, search-as-you-type, and
 * accessibility for free. On mobile the OS shows a native
 * wheel/scroll picker; on desktop it's a standard dropdown.
 */
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
    <label className="flex min-w-0 flex-1 flex-col gap-1">
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
 * Helper hook for the parent: tracks which values are mid-flight so
 * the drawer can render a "…" indicator on them. Keyed by value
 * string (which is unique within a section).
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
