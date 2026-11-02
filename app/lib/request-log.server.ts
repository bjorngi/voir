// Express request logger + span middleware (estate pattern — references/
// middleware.ts shape; blockbook's server/index.ts is the reference impl).
// Rules baked in:
//   1. NEVER log or trace health endpoints (k8s readiness probes would be
//      pure noise; liveness = kube-state-metrics pod readiness, which the
//      App APM dashboard's pod-Ready pill already reads)
//   2. normalize id-like path segments (and voir's /f/<folder-path> pages)
//      so span names stay low-cardinality — Tempo's metrics-generator
//      dimensions on span_name, raw ids would mint a series per object id
//   3. trace_id/span_id on every http_request line (Loki derived field →
//      Tempo link; the frontend+backend combined-log timeline IS the APM view)
//
// Log shape: one JSON object per line (journald → Loki picks it up as-is;
// blockbook's prod logger uses the same shape). The devbox systemd instance
// ships via journald without the app_name pod label (no pod — DEVBOX.md),
// so its lines are found under the host's journald stream; the k8s instance
// gets app_name="voir" from the pod label via the alloy pod-log relabel.
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  defaultTextMapGetter,
} from "@opentelemetry/api";
import type { NextFunction, Request, Response } from "express";
import { otelTracer, tracePropagator, tracingEnabled } from "./otel.server";

/** Health endpoints are never logged or traced (also served directly below). */
const HEALTH_PATH = /^\/(healthz|health|livez|readyz)\/?$/;

/** Collapse id-like path segments (numbers, uuids, opaque ids, anything
 *  long or hash-like) so span names stay low-cardinality. Voir's chat pages
 *  (/f/<folder-path>/s/<session-id>) are normalized wholesale to /f/:path —
 *  folder paths ARE the page key, every segment of one is an id or disk path. */
function routeOf(pathname: string): string {
  if (pathname === "/" || pathname.startsWith("/f/")) return "/f/:path";
  return pathname
    .split("/")
    .map((seg) =>
      /^\d+$/.test(seg) || /^[0-9a-f-]{8,}$/.test(seg) || seg.length > 20
        ? ":id"
        : seg,
    )
    .join("/");
}

function emit(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level: "info", ...fields }));
}

/** Register FIRST, before express.static and the request handler:
 *  app.use(requestLog); */
export function requestLog(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  // capture now: routers rewrite req.url as they dispatch (the React Router
  // express handler does exactly that), so read it before next()
  const method = req.method;
  const path = req.originalUrl.split("?")[0];
  if (HEALTH_PATH.test(path)) return next();
  const route = routeOf(path);
  // extract the W3C traceparent the browser SDK propagates → the span JOINS
  // the browser trace (one trace per request, frontend + backend)
  const span = tracingEnabled()
    ? otelTracer()?.startSpan(
        `${method} ${route}`,
        { kind: SpanKind.SERVER, startTime: start },
        tracePropagator.extract(ROOT_CONTEXT, req.headers, defaultTextMapGetter),
      )
    : undefined;
  if (span?.isRecording()) {
    span.setAttributes({
      "http.request.method": method,
      "http.route": route,
      "url.path": path,
    });
  }
  res.on("finish", () => {
    const status = res.statusCode;
    if (span?.isRecording()) {
      span.setAttribute("http.response.status_code", status);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    }
    emit({
      event: "http_request",
      method,
      path,
      status,
      ms: Date.now() - start,
      // join key with the browser side: Loki derived field → Tempo trace
      ...(span
        ? {
            trace_id: span.spanContext().traceId,
            span_id: span.spanContext().spanId,
          }
        : {}),
    });
  });
  next();
}