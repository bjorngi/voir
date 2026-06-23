/**
 * The "Chat" / "Changes" tab bar between the header and the body.
 * Only shown on chat and changes views. Both tabs are full-width
 * on mobile so they're comfortable tap targets.
 *
 * The changes marker is `?view=changes` (a query param) rather
 * than a `/c` path segment so the URL doesn't collide with a
 * folder literally named `c'.
 */
import { folderUrl, sessionUrl } from "~/lib/urls";

export interface ChangesBadge {
  files: number;
  additions: number;
  deletions: number;
}

export function ChatTabs({
  folder,
  activeSessionId,
  active,
  changesBadge,
}: {
  folder: string;
  activeSessionId: string | null;
  active: "chat" | "changes";
  changesBadge?: ChangesBadge;
}) {
  // Preserve the session id in the changes URL when we have one,
  // so the browser back button or a "Back" affordance can return
  // the user to the chat they came from.
  const base = activeSessionId
    ? sessionUrl(folder, activeSessionId)
    : folderUrl(folder);
  return (
    <nav
      aria-label="View"
      className="flex shrink-0 items-stretch border-b border-neutral-800 bg-neutral-950"
    >
      <TabLink href={base} active={active === "chat"}>
        Chat
      </TabLink>
      <TabLink href={`${base}?view=changes`} active={active === "changes"}>
        Changes
        {changesBadge && changesBadge.files > 0 && (
          <span className="ml-1.5 inline-flex items-center gap-1 font-mono text-[10px]">
            <span className="text-emerald-400">+{changesBadge.additions}</span>
            <span className="text-rose-400">−{changesBadge.deletions}</span>
          </span>
        )}
      </TabLink>
    </nav>
  );
}

function TabLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        "relative flex flex-1 items-center justify-center py-2.5 text-center text-[13px] font-medium tracking-wide " +
        (active
          ? "text-neutral-100"
          : "text-neutral-500 active:bg-neutral-900")
      }
    >
      {children}
      {active && (
        <span
          aria-hidden
          className="absolute inset-x-3 bottom-0 h-[2px] bg-neutral-100"
        />
      )}
    </a>
  );
}
