import { sessionManager } from "~/lib/sessions.server";
import { sessionStatusStore } from "~/lib/session-status.server";
import { withSpan } from "~/lib/otel.server";

/**
 * Navigation index for the phone menu (the ☰ picker).
 *
 * The picker used to show only the "Working on" shortlist and a search box:
 * with no query it was an empty sheet, which is useless on a phone where
 * there is no folder list on screen to fall back to. This endpoint gives it
 * the real thing — every registered folder, its agents, and the sessions the
 * agent knows about — in one request, fetched when the sheet opens rather
 * than on every chat page load.
 *
 * The session lists come from the same TTL-cached `session/list` the rest of
 * the app uses (stale-while-revalidate), so opening the menu does not scan
 * the agents' session stores again.
 */
/**
 * Per-folder deadline for the session list.
 *
 * A cold `session/list` is an RPC to the agent; a wedged or restarting agent
 * answers only after its own 10s timeout — and this route asks every folder.
 * Measured in production: 64 seconds for the whole menu, which made the ☰
 * button look broken. The menu is navigation, not truth: answer with the
 * folders immediately, with whatever session lists are already cached, and
 * let the background refresh fill them in for the next open.
 */
const NAV_DEADLINE_MS = 1_200;

function withDeadline<T>(work: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((resolve) =>
      setTimeout(() => resolve(fallback), NAV_DEADLINE_MS),
    ),
  ]);
}

export async function loader() {
  const started = Date.now();
  const folders = sessionManager.listFolders();
  const paths = [...new Set(folders.map((f) => f.path))];

  const tree = await Promise.all(
    paths.map(async (path) => {
      let sessions: {
        id: string;
        title: string | undefined;
        status: string | undefined;
        updatedAt: number;
        busy: boolean;
      }[] = [];
      try {
        // Cache-only: never block on an agent. `listSessions` (which waits)
        // is what the chat pages use; the menu must answer instantly.
        const list = await withDeadline(
          Promise.resolve(sessionManager.cachedSessionsFor(path)),
          [] as Awaited<ReturnType<typeof sessionManager.cachedSessionsFor>>,
        );
        sessions = list
          .slice(0, 40)
          .map((s) => ({
            id: s.id,
            title: s.title,
            status: sessionStatusStore.getStatus(path, s.id),
            updatedAt: s.createdAt,
            busy: s.busy,
          }));
      } catch {
        // A degraded agent still contributes its folder row (the sheet can
        // show it as offline); an empty session list is honest.
      }
      const agents = folders
        .filter((f) => f.path === path)
        .map((f) => f.agentName ?? "default");
      return { path, agents, sessions };
    }),
  );

  void withSpan(
    "voir.nav.index",
    {
      "voir.folders": tree.length,
      "voir.sessions": tree.reduce((n, f) => n + f.sessions.length, 0),
      "voir.ms": Date.now() - started,
    },
    () => {},
  );

  return Response.json({ folders: tree });
}
