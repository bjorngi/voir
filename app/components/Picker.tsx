import type { ActivityRow } from "~/lib/chat-types";
import { WorkingOnSection } from "./ActiveSessions";

/**
 * The hamburger menu panel — a full-screen overlay above the
 * current view. It opens and closes from the header's menu
 * button (same button, icon swaps to ✕); there is no close
 * affordance inside the panel itself.
 *
 * Single-purpose: the "Working on" shortlist (docs/
 * session-status.md) with live state pills — tap a row to
 * switch. The old folder navigation moved out (folders are
 * browsed at the root view only); the space below the list is
 * reclaimed for later use.
 */
export function Picker({
  active,
  onClose,
}: {
  active: ActivityRow[];
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-neutral-950">
      <div className="flex h-full flex-col">
        <div className="flex h-12 shrink-0 items-center border-b border-neutral-800 px-3">
          <span className="text-sm text-neutral-200">Menu</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          <WorkingOnSection
            rows={active}
            onPick={onClose}
            empty="Nothing active — star a chat to track it here."
          />
        </div>
      </div>
    </div>
  );
}