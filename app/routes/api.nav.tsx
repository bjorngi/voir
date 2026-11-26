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
        const list = await sessionManager.listSessions(path);
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
