# Timings — what is measured, and how to read it in Grafana

Voir emits timings two ways, following the estate APM pattern
(`~/.pi/agent/skills/estate-app-observability`): **spans for the backend**
(Tempo → spanmetrics → Prometheus) and **measurements for the browser**
(Faro). Nothing needs a dashboard change — the shared App APM board picks
the app up by name (`voir`), and the custom series below are queryable in
Explore.

## Backend spans

One SERVER span per HTTP request comes from `app/lib/request-log.server.ts`
(`<METHOD> <route>`); the session-manager spans nest under it because the
middleware runs the handler inside the span's context.

| Span name | When | Attributes |
|---|---|---|
| `voir.sessions.list` | every folder/session list the UI loads | `voir.folders`, `voir.sessions`, `voir.stubs`, `voir.ms`, `voir.cache.ttl_ms` |
| `voir.sessions.list.cache` | cache outcome for that list | `voir.cache` = `fresh` \| `stale` \| `shared`, `voir.cache.age_ms` |
| `voir.sessions.list.rpc` | the agent's `session/list` scan (cold) | `voir.sessions`, `voir.ms` |
| `voir.sessions.load` | opening a conversation (replay) | `voir.messages`, `voir.ms` |
| `voir.sessions.prompt` | one turn round-trip | `voir.blocks`, `voir.queue_depth`, `voir.stop_reason`, `voir.ms` |

"The app feels slow with a lot of sessions" is answerable from these three:

```promql
# p95 time to build a session list, and how big the answer was
histogram_quantile(0.95,
  sum by (le) (rate(traces_spanmetrics_latency_bucket{span_name="voir.sessions.list"}[5m])))

# how often the list had to wait on the agent scan instead of the cache
sum(rate(traces_spanmetrics_calls_total{span_name="voir.sessions.list.rpc"}[5m]))
  /
sum(rate(traces_spanmetrics_calls_total{span_name="voir.sessions.list"}[5m]))

# replay cost of opening a conversation (messages per open × time)
histogram_quantile(0.95,
  sum by (le) (rate(traces_spanmetrics_latency_bucket{span_name="voir.sessions.load"}[5m])))
```

TraceQL, to look at the slow ones and read their attributes:

```
{ name = "voir.sessions.list" && duration > 700ms }
{ name = "voir.sessions.list.rpc" } | by(voir.sessions)
{ name = "voir.sessions.load" && span.voir.messages > 100 }
```

Tuning knobs, in order of effect: `VOIR_LIST_CACHE_TTL_MS` (background refresh
cadence; a longer TTL means more stale-while-revalidate and fewer agent scans)
and the agent-side session store size (the scan reads every session file).

## Browser measurements

`voir.view.open` — milliseconds from navigation start to the first paint after
the view's data rendered; `view` is `folders|sessions|chat|files|changes` and
`size` is the row count that view had to render. Pushed from
`app/components/chat/ChatApp.tsx` via `measureView()` in `app/faro.ts`.

```promql
# p95 open time per view
histogram_quantile(0.95,
  sum by (le, view) (rate({__name__=~"faro_measurement.*voir_view_open.*ms_bucket"}[5m])))
```

(Faro's exact series names depend on the collector's OTLP→Prometheus mapping;
in Explore, filter `{app_name="voir"}` and search for `view.open`.)

## Checking locally

The mock stack blanks the telemetry envs on purpose (a mock run must not
pollute the estate). To exercise the real path:

```bash
node bin/dev.mjs --port 9300 --fresh --telemetry   # keep faro/OTLP endpoints
# then: open a few views, and look for voir.* spans in Tempo
```

Or verify only the export plumbing without any stack, by pointing the SDK at a
local sink (this is what the commit that added the spans did):

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4319 OTEL_SERVICE_NAME=voir-otel-check \
  npx tsx -e 'import("./app/lib/otel.server").then(async (m) => { await m.withSpan("voir.sessions.list", { "voir.sessions": 1 }, () => {}); })'
# any OTLP/HTTP collector on :4319 will receive the span
```
