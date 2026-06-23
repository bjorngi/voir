/**
 * The "Chat" / "Diff" tab bar between the header and the body.
 * Only shown on chat and diff views. Both tabs are full-width
 * on mobile so they're comfortable tap targets.
 *
 * The diff marker is `?view=diff` (a query param) rather than
 * a `/d` path segment so the URL doesn't collide with a folder
 * literally named `d`. See parseRoute() in ~/lib/route-parse
 * for the disambiguation rules.
 */
import { folderUrl, sessionUrl } from "~/lib/urls";

export function ChatTabs({
  folder,
  activeSessionId,
  active,
}: {
  folder: string;
  activeSessionId: string | null;
  active: "chat" | "diff" | "timeline";
}) {
  // We preserve the session id in the diff/timeline URL when we
  // have one, so a "Back" affordance (or the browser back button)
  // can return the user to the chat they came from. When the
  // view was opened from the session list, there's no session id
  // and we drop them on the session list.
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
      <TabLink href={`${base}?view=diff`} active={active === "diff"}>
        Diff
      </TabLink>
      <TabLink href={`${base}?view=timeline`} active={active === "timeline"}>
        Timeline
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
        "relative flex-1 py-2.5 text-center text-[13px] font-medium tracking-wide " +
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
