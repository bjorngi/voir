import { useEffect } from "react";

/**
 * Close-on-outside-click / Escape behaviour for a popover.
 *
 * The popover attaches `mousedown` (outside) and `keydown`
 * (Escape) listeners to the document while `open` is true
 * and removes them on close. The listeners check the
 * container ref so clicks inside the popover do not
 * immediately close it.
 *
 * Used by the chat message and session-row debug popovers.
 */
export function useDebugPopoverDismiss(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (open: boolean) => void,
) {
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, ref, setOpen]);
}
