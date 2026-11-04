# Rich content: the module system (design, v1 spec)

**Status:** design + **phase 1 built** (registry, markdown seams,
mermaid / svg / table / chart / card / html / image / ha-entity
modules — see "Phase 1 — as built"). Grafana is **phase 2**, by
decision (2026-11-04): start with **registry + graphics + cards**;
then the grafana modes — panel image first, live embed next (the
spec's recommendation stands). Everything still anchored per section;
check before changing.

**Scope:** a module-based system for voir to *render* rich output —
Grafana graphs first, then whatever an agent or machine lane wants
 to show: diagrams, HTML mini-apps, SPAs, SVG, charts, tables,
 cards, inline entity chips. Agent-agnostic by construction: agents
deliver ordinary content in ordinary channels; voir decides how to
render it, and an agent that knows nothing about voir degrades to
plain text.

**2026-11-04 additions (decisions from the spec review):**

- **Inline carrier** — modules also bind *inside* text: inline
  code spans with a namespace prefix (`ha:<entity_id>`), rendered
  as chips in the prose, next to not below the words. Blocks stay
  block-level; the inline seam is a separate detector list.
- **Live state** — a chip can show the entity's *current* value,
  fetched through a voir proxy route (read-only, token server-side,
  env-gated). No token → the chip renders name-only (honest). No
  SSE for v1: fetch on render + a 60s refresh while the chat is
  visible.
- **Interaction** — buttons that do something, at two trust levels:
  *agent-mediated (v1)* — card actions send/prefill a message the
  agent turns into action via its own tools (HA toggling through
  the agent that owns the integration — deliberate tap, ordinary
  machinery, no new capabilities granted); *voir-proxied (v2)* —
  allowlisted direct service calls from the card (light toggle
  without an agent turn), shaped like the grafana proxy when the
  need presses. Inline chips stay **read-only in v1** — a tap
  beside prose must never accidentally send a message.

## The principle: carriers vs renderers

Content arrives through a small number of **carriers** (wire
channels that already exist in ACP/voir); rendering is chosen by a
**registry of modules** (voir-local, pluggable). No new protocol —
every carrier is something an arbitrary ACP agent can already emit.

```
carrier                what it is                        today
─────────────────────  ───────────────────────────────  ──────────
fenced block           ```<lang> …``` in any text       markdown
inline span            `ha:<entity_id>` namespace code   markdown
                       inside prose → chip
tool content           ACP tool_call/tool content        already
                       blocks (image/diff/text) +
                       rawInput (the ask_user pattern)
artifact reference     [Artifact: <id>] text marker      like [Image: …]
                       backed by voir's artifact store
attachment             user images (upload store)        shipped
```

Detection: the registry is consulted in order for every candidate
carrier; first module that matches renders it; **none → the
carrier's honest fallback** (the existing rendering: code block,
tool outline, marker text). Degradation is textual, like the
sentinel pattern — a foreign host shows the raw content and loses
nothing.

## The module contract

`app/lib/render/registry.ts` + one file per module under
`app/lib/render/modules/`. A module is:

```ts
interface RenderModule {
  id: string;                    // "mermaid", "html", "chart", …
  /** When this module applies; evaluated in registry order. */
  detect: (carrier: CarrierContext) => boolean;
  /** Trust tier → the wrapper the registry applies. */
  trust: "static" | "sandboxed" | "live";
  /** The renderer. Lazy-imported so unused modules stay out of
   *  the critical bundle. */
  Component: React.ComponentType<RenderProps>;
  /** Mobile-first default height; a chevron collapses/expands. */
  height?: { default: number; max: number };
  /** Streaming: most rich blocks render only when the turn has
   *  settled (the content stops growing mid-parse otherwise). */
  deferToSettled?: boolean;
}
```

`CarrierContext` carries the source coordinates: which message,
which fenced block (lang + body), or which tool call (name, kind,
status, content blocks, rawInput, toolCallId) — renderers bind
buttons to actions through the same context.

The **inline** carrier is narrower: a namespace prefix on an
inline code span (`ha:sensor.kitchen_temperature`), matched by
inline detectors (separate list from the block registry — the
prose seam must never swallow ordinary `inline code`), rendering
a chip in the text flow.

## Interaction (buttons that do something)

Card actions and their trust story:

| action kind | what the tap does | v1? |
| --- | --- | --- |
| `send` | sends the value as a user message immediately (the ask_user tap-to-send precedent) | yes |
| `prefill` | drops the value into the composer as an editable draft (the voice tap-to-edit seam) | yes |
| `link` | opens the URL (`target=_blank`, relay noreferrer — same trust surface as any markdown link) | yes |
| `proxy` | a voir-side allowlisted service call ("toggle light.direct, no agent turn) | v2 — needs the allowlist config + the same server-side-token pattern |

Agent-mediated is the v1 answer for "a button does something":
the value is an instruction, the agent that owns the integration
(HA, git, grafana) performs it. One caveat worth honoring: the
value shown on the button should tell the truth — the card
component renders `label` and sends `value`, and they may differ
only when the difference is harmless (e.g. label "Ack" value
"acknowledge alarm #42").

Inline chips are read-only in v1: state shows, taps do nothing
(a chip is decoration next to prose; interaction belongs to
cards). Chip live-state comes from `GET /api/ha/state/:entity`
(`$VOIR_HA_URL` + `$VOIR_HA_TOKEN`, unset → 503 `{disabled}` →
name-only chip), fetched on render + every 60s while visible.

Trust tiers drive the wrapper, not the module:

| tier | wrapper | who gets it |
| --- | --- | --- |
| `static` | inline, no script execution (shiki, `<img>`) | svg, images, csv table, math |
| `sandboxed` | `<iframe sandbox="allow-scripts">` (NO `allow-same-origin` → opaque origin, voir's cookies/localStorage invisible), injected CSP, fullscreen + "open standalone" actions | mermaid, html/SPA, json cards with behavior |
| `live` | sandboxed iframe pointed at a **voir proxy route** — secrets stay server-side (the voice/STT pattern) | grafana embeds, video, any internal service |

Security posture (non-negotiable, this is the README's "Security:
this is your job" extended to agents' output):

- Agent content is **untrusted input**, even though agents are
  ours: a prompt-injected agent must not gain a scripting
  channel into voir's origin.
- `srcdoc`/proxied iframes get an explicit `Content-Security-Policy`
  injected (a `default-src 'none'` baseline plus per-module
  allowlists, e.g. `esm.sh` + `cdn.jsdelivr.net` for SPA runtimes,
  grafana origin for embeds).
- No module ever gets `allow-same-origin`. If a renderer needs
  voir data, voir passes it as props at render time (the chart
  module gets its series as JSON, not via fetch).
- The artifact/asset routes set `Content-Security-Policy: sandbox`
  + `X-Content-Type-Options: nosniff` like `/api/uploads/:id`.

## Built-in modules (v1 — as decided 2026-11-04)

1. **`mermaid`** — any ```mermaid block → rendered diagram (mermaid
   npm client-side, dark theme, `securityLevel: "strict"`).
   The single highest-demand agent graphic (flowcharts, sequence,
   state, ER, gantt). Rendered into the document — diagram syntax,
   not user scripts; strict mode escapes labels — so the static
   tier, no iframe.
2. **`html`** — ```html blocks → sandboxed iframe (`allow-scripts`,
   never `allow-same-origin`, injected CSP). One file =
   one app: inline CSS/JS, import maps for a CDN runtime.
   Covers dashboards, comparisons, calculators, visual previews.
   This is the 95% case for "whole SPA" too — Claude-artifacts-
   style single-file apps — which is why the separate **artifact
   store is deferred** (decision).
3. **`svg`** — ```svg blocks and image/svg content blocks →
   `<img src=object-url>` (svg in `<img>` has scripts disabled
   natively — the cheap safe tier). Never inline into the
   document, same reason uploads reject SVG.
4. **`table`** — ```csv``` / ```tsv``` → rendered table (mobile:
   horizontal scroll + sticky header), numeric columns get
   sparklines (hand-rolled inline SVG, no dependency).
5. **`chart`** — ```voir-chart``` JSON: `{ title, unit, series:
   [{ label, points: [ts, v]… }], type: "line" | "bar" | "area" }`
   → client-rendered chart (uPlot — ~40KB, Canvas, mobile-fast,
   dark-themeable). This is the **agent-agnostic** graph path: any
   agent with any MCP data source can query and emit the block —
   no grafana coupling, no voir secrets.
6. **`card`** — ```voir-card``` JSON: `{ title, pill?, rows?:
   [{k, v, delta?, spark?}], actions?: [{label, kind: "send" |
   "prefill" | "link", value}] }` → a dense summary card whose
   buttons act per the interaction table. The machine-lane
   rendering (checkup verdicts, briefings, alerts) generalizing
   the ask_user question card.
7. **`image`** — fenced ```image``` data-URIs and tool-result
   image content blocks → thumbnails/fullscreen, like user
   messages.
8. **`ha-entity`** (inline) — `ha:<entity_id>` inline spans →
   entity chips (name + live state via `GET /api/ha/state/:entity`
   when `$VOIR_HA_URL`/`$VOIR_HA_TOKEN` are set, name-only
   otherwise). The inline seam's first module — read-only (see
   Interaction).

Deferred to later phases: grafana modes (phase 2: panel image →
live embed), trace waterfall (Tempo json → span timeline),
log-stream view, katex, maps, audio/video, checklists with live
state, artifact store.

## Why not d3-only (review 2026-11-04)

The question came up during the phase-1 build: if d3 can draw"anything",
do we need the other modules? d3 is the free-form escape hatch
INSIDE the system, not the system itself. It structurally cannot:

1. **Compact notation (mermaid).** Mermaid's value isn't rendering,
   it's the few-token semantic format agents emit reliably
   (`flowchart LR; A-->B`). The d3 equivalent is 20 lines of
   error-prone code per diagram. It's markdown-vs-html: cheap,
   typed, and a de-facto agent convention.
2. **Apps and controls (html).** Forms, buttons, layout, text,
   tables-as-DOM — visualization code is the wrong tool. The html
   module is the general sandbox; d3 is that sandbox specialized
   with d3 preloaded. Same trust tier, different load.
3. **voir-bound interaction and live data (card, ha-entity).** The
   sandbox is opaque-origin BY DESIGN — d3 code can never touch
   voir's APIs, tokens, or transcript. Buttons that send/prefill
   messages and chips that show live entity state must render
   voir-natively. This is the load-bearing split: agent code
   draws pictures; voir modules act.
4. **Cheap static carriers (svg-as-img, images, tables).** No
   script tier needed; select/copy/screen-reader semantics are
   real DOM, not sandboxed DOM.

The one redundant-looking module is `chart` (uPlot): a d3 line
chart is 20 lines the agent would re-write (badly, variably) every
time. uPlot's 40KB buys reliable, consistently-themed time axes
for the common case — machine lanes emit data; the renderer owns
the axis code. Keep; it's the smallest, most reliable leaf.

Module count is not the complexity cost — the four structural
members are (registry, sandbox, voir-native actions/data, markers).
Each module is a small leaf on one of them.

## Nudging the agent (how it knows any of this exists)

Agents know voir's conventions only through their context. The nudge
is a **pi package that IS this repo** —voir's package.json carries a
`pi` manifest listing `extensions/` + `skills/`; `pi install
/home/bjorn/code/voir` (local package, read live from the checkout,
no copying) makes every pi process on the machine load them. All of
it updates with `git pull` — the docs ship where the code ships.

- **Layer 0 — the env-gated extension** (`extensions/voir-rich/
  index.ts`): acp-lib.mjs sets `VOIR=1` next to `ACP_FOLDER` at
  spawn; the extension checks `process.env.VOIR` at registration
  and appends a system-prompt section on every turn **only under
  voir**. Terminal pi, print-mode scripts, other hosts: silent.
  The section text is **assembled from the module guides**
  (`assembleNudge()` in registry.ts) — modules carry their own
  emission contracts (`guide` field), so the prompt can never
  drift from the registry: adding a module without a guide makes
  it invisible to agents; the fix lives in the same file. Opt-out:
  `VOIR_NUDGE=off` skips the section (the skill stays).
  Prompt-variance note (found in testing): models reach for
  generic ```json "summary block" conventions when asked for "a
  card" — the section therefore carries an**imperative mapping
  line** ("the fence tag MUST be voir-card/…, never a generic
  ```json") + a micro-example; after that, 3/3 print runs and the
  ACP path emitted exact-schema cards. As the second line of
  defense, the registry **shape-sniffs plain ```json**: a payload
  matching the card/chart schema is claimed by that module (see
  matchFenced's low-priority fallback) — generic JSON stays code.
- **Layer 1 — the skills** (in this package): `voir-rich` (full
  block schemas, examples, the choice guide) and `voir-platform`
  (voir's implementation for agents: the inbox API, push, files/
  upload routes, session-status, env vars, what the host reads
  from initialize/models — integration knowledge). Name +
  description ride the system prompt cheaply everywhere; bodies
  load on demand. The descriptions scope them to voir-ish tasks,
  so terminal models ignore them.
- **Layer 2 — per-project AGENTS.md**: read by pi everywhere — the
  right home for project-specific *preferences* ("use voir-chart
  for our CI metrics"), never for voir-only vocabulary (that
  would tell terminal pi to emit JSON cards as raw text).
- **Layer 3 — tool descriptions**: brokered agents read MCP tool
  descriptions; an estate-broker tool can carry the summary or
  return the spec verbatim when richer routing is ever needed.
- **Layer 4 — the user**: "render this as mermaid / as a card / as
  d3" works in any session, anytime.

## Grafana: three modes (the first real use)

The estate's agents talk to grafana MCP (PromQL/LogQL/Tempo
queries, dashboard search, `generate_deeplink`). "Graphs on
demand" composes those tools with renderers:

| mode | flow | property |
| --- | --- | --- |
| **charted query** (`chart` module) | agent runs `grafana_query_prometheus` → emits ```voir-chart with the series | zero grafana coupling; works for ANY data source; fits the transcript |
| **panel image** (`grafana-render` module) | agent (or fenced JSON) names dashboard+panel+range → voir proxy calls grafana's **render API** → PNG → the block shows it; can also ride **push notifications** (web push `image` field — the graph in the shade) | dead simple, one auth path, but a snapshot the moment it's drawn |
| **live embed** (`grafana-embed` module) | sandboxed iframe → voir proxy → grafana kiosk panel (`/d-solo/…?kiosk&theme=dark`) → live, zoomable | always current + grafana UI quality; needs grafana-side auth for HTML embeds (Bearer headers work for the render API, cookies/anon for embeds — verify; an embed-scoped auth-proxy or anonymous role limited to the render/embed paths would do) |

The proxy: `GET /api/grafana/*` → `$VOIR_GRAFANA_URL` with
`Authorization: Bearer $VOIR_GRAFANA_TOKEN` (service account,
server-side only — the agent never holds it; same pattern as the
voice STT key and the inbox token). Path allowlist
(`/render/*`, `/d-solo/*`, `/d/*`) — grafana's whole admin
surface must not become agent-reachable via voir.

**decision — build order:** panel image first (no grafana config
changes, works in push) vs live embed first (the actual "live
graph" experience, needs grafana settings verified). Recommendation:
image first, live embed immediately after — they share the proxy.

## Extensibility

- **v1 — in-repo modules:** `app/lib/render/modules/*.tsx`
  registered in the registry; adding a module is a file + a
  registry line, shipped with the build.
- **v2 — declarative modules:** JSON module specs in
  `$VOIR_DATA_DIR/modules/*.json` — iframe/URL-template modules
  ("open `https://internal.service/panel?x=$1` sandboxed with
  these params") without touching voir's code. Covers
  house-internal services cheaply.
- **v3 — served ESM modules:** custom renderer code as ESM from a
  voir-served static dir, loaded in the opaque-origin sandbox.
  Real plugin-ability at runtime; defer until a concrete need
  presses.

The registry itself stays carrier-first and ordered; user
modules (v2+) append before the fallback, never shadow built-ins
unless explicitly flagged.

## Replay, persistence, streaming

- Fenced blocks + tool content survive everything (transcript
  truth). Marker-based artifacts re-attach on replay exactly like
  image markers (`rewriteImageMarkers` is the precedent; a
  `rewriteArtifactMarkers` would join it) — the artifact store
  keeps bytes + meta (`$VOIR_DATA_DIR/artifacts/`).
- Streamed turns: a fenced block grows chunk by chunk — renderers
  get the *complete* block only (`deferToSettled`), the streaming
  frame shows the plain code like today. Tool content is
  complete per `tool_call_update`.
- **Replay coalescing (fixed 2026-11-04 — the refresh regression):
  the replay direction re-streams messages piecewise, and two
  defects used to kill rendering on refresh/session-load: (1)
  replay chunks were not coalesced — each became its own message,
  so fences split across per-chunk messages and no module ever
  matched; (2) the replay-boundary rule flipped `replaying` off on
  *any* non-chunk update — `tool_call`/`tool_call_update`, which
  pi-acp interleaves WITHIN the replayed transcript — leaving
  later chunks stuck `streaming: true` (no close ever ran for
  them; the settle gate never lifted). Fix: contiguous same-kind
  chunks coalesce during replay regardless of the flag; the
  boundary now flips only on the post-transcript end signals
  (`available_commands_update`, `session_info_update`), with a
  400ms grace for stragglers and a close at both completion
  sites. Verified on the deployed service: post-replay transcript
  = one coalesced message, all fences whole, flag settled.
- Both user and agent messages go through the registry (a user
  pasting ```mermaid gets the real rendering too).

## Build order (proposal)

1. Registry + fenced-block seam in `Message.tsx`'s markdown
   `code`/`pre` components + `mermaid`, `svg`, `table`, `chart`
   (uPlot), `voir-card`, `image` modules + tests (detection matrix,
   rendering on mock-agent transcripts).
2. Grafana proxy route + `grafana-render` (panel image) + push
   payload with `image` + `grafana-embed` (live panel) once the
   grafana-side embed auth is verified.
3. `html` module (sandboxed single-file apps) + SPA import-map
   recipe.
4. Artifacts (store + markers) only when a real carrier needs to
   exceed what one fenced block carries (big SPAs, machine-lane
   uploads).
5. Declarative (v2) modules when the first "open internal service
   X in a sandboxed panel" need appears.

## Testing

- **detection matrix:** every carrier shape × module → expected
  module/fallback (pure, no rendering).
- **mock agent:** `mock-acp` gains a command/turn emitting each
  block type (```mermaid, ```voir-chart, tool image content) so
  the e2e bridge tests assert the SSE transcript carries them and
  the ChatMessage projection marks them renderable.
- **iframe safety:** html module's wrapper includes the sandbox +
  CSP attrs asserted in a test; no module may emit
  `allow-same-origin` (lint-able invariant).

## Open questions

1. mermaid: `static` inline (strict mode) vs `sandboxed` iframe —
   decide at implementation (bundle + perf on mobile vs isolation).
2. Chart lib: uPlot (recommended) — ECharts as the alternative if
   richer interactions prove needed.
3. Grafana embed auth: verify the instance's render/embed behavior
   with a service-account token before choosing the live path's
   auth shape (auth-proxy header vs anonymous-embed role).
4. Artifact store shape when built: single files vs directory
   bundles (an SPA is multiple files).
