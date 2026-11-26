// Backend tracing (estate pattern, OBSERVABILITY.md §4.8, faro-recipe.md §6)
// — manual, bundle-safe OTLP export. One SERVER span per request is created
// in the request-log middleware (app/lib/request-log.server.ts): it extracts
// the W3C `traceparent` header the browser's faro TracingInstrumentation
// propagates on same-origin fetches, so backend spans join the browser's
// trace, and every http_request log line carries trace_id/span_id — the Loki
// derived field turns them into Tempo links.
//
// Why manual spans (no @opentelemetry/instrumentation-*): the production
// servers are bundles (vite/`react-router build` output, no auto-hook chance;
// the devbox one runs under tsx but stays on the same manual shape for
// parity). Plain SDK packages bundle fine.
//
// Config (standard OTel envs, set in ha/voir-deployment.yaml; devbox systemd
// instance exports the tailnet NodePort — DEVBOX.md):
//   OTEL_EXPORTER_OTLP_ENDPOINT         base endpoint; /v1/traces appended
//   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT  full endpoint (wins over base)
//   OTEL_SERVICE_NAME                   service.name; the estate convention
//                                       is the one name — faro app_name =
//                                       OTEL_SERVICE_NAME = pod label app
// Unset endpoint → tracing off, zero overhead.
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  context,
  trace,
  SpanStatusCode,
  type Attributes,
  type Span,
  type Tracer,
  type TextMapPropagator,
} from "@opentelemetry/api";

// NOTE on env timing: bin/server.ts loads .env in its module BODY (after all
// static imports evaluate), so env-dependent state must be read lazily —
// see tracesEndpoint(), not at import time.
function tracesEndpoint(): string | undefined {
  return (
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    (process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, "") +
        "/v1/traces"
      : undefined)
  );
}

/** true when OTLP traces are configured — middleware skips span work otherwise.
 *  Lazy: .env is loaded into process.env after imports run. */
export function tracingEnabled(): boolean {
  return Boolean(tracesEndpoint());
}

let tracer: Tracer | undefined;

/** Tracer for the request-log middleware; undefined when tracing is off.
 *  Initialized on first call (i.e. on the first request, after .env load). */
export function otelTracer(): Tracer | undefined {
  if (!tracer && tracingEnabled()) {
    const provider = new TracerProvider({
      resource: resourceFromAttributes({
        "service.name": process.env.OTEL_SERVICE_NAME || "voir",
      }),
      spanProcessors: [
        new BatchSpanProcessor({
          exporter: new OTLPTraceExporter({ url: tracesEndpoint() }),
        }),
      ],
    });

    // flush pending spans on shutdown (k8s sends SIGTERM on rollout; the
    // systemd unit gets the same on `systemctl restart voir`)
    const shutdown = () => {
      provider.shutdown().catch(() => {}).finally(() => process.exit(0));
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);

    tracer = provider.getTracer("voir");
  }
  return tracer;
}

// IMPORTANT: extract traceparent with THIS propagator, not
// `propagation.extract()` from @opentelemetry/api — the api package's global
// propagator is a no-op until an SDK registers it, and without an explicit
// propagator every span silently gets a fresh trace (the browser trace does
// NOT join). This module deliberately stays off the api globals.
const propagator = new W3CTraceContextPropagator();
export const tracePropagator: TextMapPropagator = propagator;
/**
 * Time one unit of work as a child of the request span.
 *
 * Why spans rather than counters: the estate's Grafana stores timings in
 * Tempo, and the metrics-generator turns span *durations* into Prometheus
 * series (spanmetrics), so a well-named span is a latency histogram with a
 * trace attached — no metrics SDK, no second pipeline, and any slow sample
 * can be opened and read.
 *
 * Naming matters: spanmetrics keys on `span_name`, so use a stable,
 * low-cardinality name (`voir.sessions.list`), never ids.
 *
 * Tracing off (no OTLP endpoint) → the function is a passthrough with no
 * allocation. Errors are recorded on the span and re-thrown unchanged.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span | undefined) => Promise<T> | T,
): Promise<T> {
  const tracer = otelTracer();
  if (!tracer) return await fn(undefined);
  return await tracer.startActiveSpan(name, async (span) => {
    try {
      span.setAttributes(attributes);
      const result = await fn(span);
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error)?.message ?? String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
