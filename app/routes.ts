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
  route("api/folder-diff", "routes/api.folder-diff.tsx"),
  route("api/folders", "routes/api.folders.tsx"),
] satisfies RouteConfig;
