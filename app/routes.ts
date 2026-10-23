import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  // The / index shows the list of folders.
  index("routes/index.tsx"),
  // /f/<path>  and  /f/<path>/s/<id>  — same component, different states.
  route("f/*", "routes/chat.tsx"),
  // Static API routes
  route("api/sessions/:sessionId/stream", "routes/api.stream.tsx"),
  route("api/sessions/:sessionId/meta", "routes/api.session-meta.tsx"),
  route("api/sessions/:sessionId/action", "routes/api.session-action.tsx"),
  route("api/folder-files", "routes/api.folder-files.tsx"),
  route("api/folder-file", "routes/api.folder-file.tsx"),
  route("api/tts", "routes/api.tts.tsx"),
  route("api/folder-diff", "routes/api.folder-diff.tsx"),
  route("api/folders", "routes/api.folders.tsx"),
  // Voir-local session status overlay (docs/session-status.md):
  // the "Working on" snapshot (GET) and status transitions (POST).
  route("api/session-status", "routes/api.session-status.tsx"),
  route("api/timeline-restore", "routes/api.timeline-restore.tsx"),
  route("api/timeline-diff", "routes/api.timeline-diff.tsx"),
  route("api/commit", "routes/api.commit.tsx"),
  route("api/push", "routes/api.push.tsx"),
  route("api/commits", "routes/api.commits.tsx"),
  // Web Push (see docs/two-way.md). Named /api/notify because
  // /api/push is the git-push endpoint. One file, four paths —
  // distinct ids are required when a file backs several routes.
  route("api/notify/config", "routes/api.notify.tsx", {
    id: "api-notify-config",
  }),
  route("api/notify/subscribe", "routes/api.notify.tsx", {
    id: "api-notify-subscribe",
  }),
  route("api/notify/unsubscribe", "routes/api.notify.tsx", {
    id: "api-notify-unsubscribe",
  }),
  route("api/notify/test", "routes/api.notify.tsx", {
    id: "api-notify-test",
  }),
  // Machine-initiated conversations (docs/two-way.md Mode 1).
  route("api/inbox", "routes/api.inbox.tsx"),
] satisfies RouteConfig;
