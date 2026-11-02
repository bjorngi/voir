// app/faro.ts — estate frontend observability (OBSERVABILITY.md §4.9,
// ~/code/infra/observability/faro-recipe.md §2). Uncaught errors, console
// output, web vitals, sessions and fetch/XHR spans land in the shared LGTM
// stack via https://faro.stackunderflow.no/collect; the backend spans
// (app/lib/otel.server.ts + app/lib/request-log.server.ts) join the same
// trace because the API is same-origin — traceparent propagates on every
// fetch automatically.
//
// VITE_FARO_* come from .env (never hardcode the API key in git):
//   VITE_FARO_ENABLED=true
//   VITE_FARO_API_KEY=<contents of ~/code/infra/keys/faro-api-key>
//   VITE_FARO_URL=https://faro.stackunderflow.no/collect
// They are baked into the client bundle at build time (vite): present in
// .env for local/server builds, as Docker build args for image builds.
// The key is a spam bar, not a secret — it ships in the public bundle by
// design; the origin CORS allowlist + the collector's rate limit are the bar.
import {
  getWebInstrumentations,
  initializeFaro,
  InternalLoggerLevel,
  faro,
} from "@grafana/faro-web-sdk";
import { TracingInstrumentation } from "@grafana/faro-web-tracing";

const APP_NAME = "voir"; // one word — becomes the Loki label app_name

export function initFaro() {
  if (!import.meta.env.VITE_FARO_ENABLED) return;
  initializeFaro({
    // the API is same-origin (this app's own express server serves both the
    // chat UI and /api), so the SDK's traceparent propagation reaches the
    // backend spans without CORS configuration — full-stack in one Tempo trace.
    url: import.meta.env.VITE_FARO_URL,
    apiKey: import.meta.env.VITE_FARO_API_KEY,
    app: {
      name: APP_NAME,
      // optional but recommended: shows up on every event in Grafana
      version: import.meta.env.VITE_APP_VERSION ?? "dev",
      environment: import.meta.env.MODE, // development | production
    },
    internalLoggerLevel: import.meta.env.DEV
      ? InternalLoggerLevel.WARN
      : InternalLoggerLevel.ERROR,
    instrumentations: [
      ...getWebInstrumentations(), // errors, console, web-vitals, session, page
      new TracingInstrumentation(), // fetch/XHR spans → Tempo
    ],
  });
}

/**
 * Report an error a React Router ErrorBoundary caught. Boundary
 * catches never reach window.onerror — React swallows them — so
 * the SDK's error instrumentation is blind to them and a
 * user-visible "Oops!" page never shows up in the faro logs
 * (that blind spot is exactly why server-side 500s rendering the
 * boundary looked like "no frontend errors" in Grafana).
 *
 * `faro` is a live proxy: before initFaro() — or when
 * VITE_FARO_ENABLED is unset — its api is a no-op, so this is
 * safe to call in every environment.
 */
export function reportBoundaryError(
  error: unknown,
  context?: Record<string, string | undefined>,
) {
  const err = error instanceof Error ? error : describeNonError(error);
  const ctx = Object.fromEntries(
    Object.entries(context ?? {}).filter(([, v]) => v !== undefined),
  );
  faro.api.pushError(err, {
    context: { source: "react-router ErrorBoundary", ...ctx },
  });
}

function describeNonError(error: unknown): Error {
  // React Router throws Response objects for error responses
  // (status/statusText) — String(response) is useless
  // ("[object Response]"), so lift the useful bits out.
  const res = error as { status?: number; statusText?: string; data?: unknown };
  if (typeof res?.status === "number") {
    const data = res.data && typeof res.data === "string" ? `: ${res.data}` : "";
    return new Error(`HTTP ${res.status} ${res.statusText ?? ""}${data}`);
  }
  return new Error(String(error));
}