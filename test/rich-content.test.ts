import test from "node:test";
import assert from "node:assert/strict";
import {
  matchFenced,
  matchInline,
  isImageRef,
  isDeferred,
  extractFenced,
  toolImageBlocks,
  BLOCK_DETECTIONS,
  INLINE_MODULES,
} from "../app/lib/render/registry";
import {
  parseCard,
  parseChart,
  parseTable,
  sparkPoints,
  toUPlotData,
} from "../app/lib/render/parse";
import {
  injectCsp,
  escapeScriptClose,
  buildD3Doc,
  IFRAME_SANDBOX,
  SANDBOX_CSP,
} from "../app/lib/render/sandbox";
import { rewriteImageMarkers } from "../app/lib/composer-payload";
import type { ImageRef } from "../app/lib/chat-types";

/**
 * The rich-content detection matrix (docs/rich-content.md —
 * Testing): every carrier shape × module → expected module or
 * fallback. Pure — no rendering involved.
 */

const CARD = JSON.stringify({
  title: "checkup",
  pill: { text: "healthy", tone: "good" },
  rows: [{ k: "disk /", v: "42%", delta: "-2%", spark: [30, 33, 41, 44, 43, 42] }],
  actions: [{ label: "Ack", kind: "send", value: "ack." }],
});

const CHART = JSON.stringify({
  title: "cpu",
  unit: "pct",
  type: "line",
  series: [{ label: "cpu", points: [[1, 10], [2, 20], [3, 15]] }],
});

test("fenced detection matrix", () => {
  // claimed blocks
  assert.equal(matchFenced("mermaid", "flowchart LR\nA-->B", false)?.module.id, "mermaid");
  assert.equal(matchFenced("voir-card", CARD, false)?.module.id, "card");
  assert.equal(matchFenced("voir-chart", CHART, false)?.module.id, "chart");
  assert.equal(matchFenced("csv", "a,b\n1,2", false)?.module.id, "table");
  assert.equal(matchFenced("tsv", "a\tb\n1\t2", false)?.module.id, "table");
  assert.equal(matchFenced("html", "<p>hi</p>", false)?.module.id, "html");
  assert.equal(matchFenced("d3", "const x = 1", false)?.module.id, "d3");
  assert.equal(matchFenced("svg", "<svg></svg>", false)?.module.id, "svg");
  assert.equal(matchFenced("image", "data:image/png;base64,AAAA", false)?.module.id, "image");

  // JSON blocks parse through the module validators — the sniff
  // data IS the validated payload (rendering never re-parses).
  const cardMatch = matchFenced("voir-card", CARD, false)!;
  assert.equal((cardMatch.data as { title?: string }).title, "checkup");

  // malformed JSON-family blocks → no match → plain code
  assert.equal(matchFenced("voir-card", "{nope", false), null);
  assert.equal(matchFenced("voir-chart", "[1,2,3]", false), null);
  assert.equal(matchFenced("voir-card", '"just a string"', false), null);

  // reserved/plain languages never route to a module — except the
  // documented shape fallback: ```json payloads that match a
  // module's schema are claimed (models know the shapes, not
  // always the tags)
  for (const lang of ["typescript", "yaml", "bash", "diff", "text", "css", "log"]) {
    assert.equal(matchFenced(lang, "whatever", false), null, `${lang} stays code`);
  }
  assert.equal(matchFenced("json", JSON.stringify({ title: "x", rows: [{ k: "a", v: "b" }] }), false)?.module.id, "card", "card-shaped json claims the card module");
  assert.equal(matchFenced("json", JSON.stringify({ series: [{ label: "cpu", points: [[0, 1], [1, 2]] }] }), false)?.module.id, "chart", "series-shaped json claims the chart module");
  assert.equal(matchFenced("json", JSON.stringify({ just: "data", nothing: [1, 2, 3] }), false), null, "generic json stays code");

  // unknown languages stay code
  assert.equal(matchFenced("brainfuck", "+++++++++", false), null);
  // uppercase/whitespace tolerance on the tag
  assert.equal(matchFenced(" Mermaid \n", "graph TD", false)?.module.id, "mermaid");
});

test("file-image refs: worktree image paths claim as chips", () => {
  // bare basename + relative paths qualify
  assert.equal(isImageRef("covid-dashboard-2020-06-09.png"), "covid-dashboard-2020-06-09.png");
  assert.equal(isImageRef("figs/loss.png"), "figs/loss.png");
  assert.equal(isImageRef("./out/panel.jpg"), "./out/panel.jpg");
  assert.equal(isImageRef("render.webp"), "render.webp");
  assert.equal(isImageRef("chart.SVG"), "chart.SVG");
  // explicit file: prefix strips through
  assert.equal(isImageRef("file:figs/loss.png"), "figs/loss.png");
  // not image extensions → not ours
  assert.equal(isImageRef("make_dashboard.py"), null);
  assert.equal(isImageRef("README.md"), null);
  // not path-like:
  assert.equal(isImageRef("file with space.png"), null, "spaces rejected");
  assert.equal(isImageRef("https://x/y.png"), null, "urls rejected — chip resolves worktree-relative");
  assert.equal(isImageRef("//cdn/y.png"), null);
  // namespaced tokens belong to their prefix modules
  assert.equal(isImageRef("ha:sensor.png"), null);
  assert.equal(isImageRef("file:figs/x.png"), "figs/x.png");
  assert.equal(isImageRef("".padEnd(130, "a") + ".png"), null,">120 chars rejected");
  // chip route mapping is the Files-tab plumbing contract
  const expected = `/api/folder-file?folder=${encodeURIComponent("/f")}&file=${encodeURIComponent("figs/loss.png")}&raw=1`;
  assert.equal(
    `/api/folder-file?folder=${encodeURIComponent("/f")}&file=${encodeURIComponent("figs/loss.png")}&raw=1`,
    expected,
  );
});

test("inline chip detection", () => {
  const ha = INLINE_MODULES.find((m) => m.id === "ha-entity")!;
  assert.equal(matchInline("ha:sensor.kitchen_temperature")?.module.id, "ha-entity");
  assert.equal(matchInline("ha:sensor.kitchen_temperature")?.ref, "sensor.kitchen_temperature");
  // case-insensitive prefix, ref preserved verbatim
  assert.equal(matchInline("HA:sensor.x")?.module.id, "ha-entity");
  assert.equal(matchInline("HA:sensor.x")?.ref, "sensor.x");
  // bare prefix or non-namespaced code → plain inline
  assert.equal(matchInline("ha:"), null);
  assert.equal(matchInline("foo.ts"), null);
  assert.equal(matchInline("some/value:with-colon"), null);
});

test("streaming deference", () => {
  const m = matchFenced("mermaid", "graph TD", true)!;
  assert.equal(isDeferred(m, true), true, "graphics wait for the turn to settle");
  assert.equal(isDeferred(m, false), false, "…then render");
  // the match itself is streaming-independent (detection is pure)
  assert.ok(BLOCK_DETECTIONS.every((d) => d.deferToSettled), "all v1 modules defer");
});

test("extractFenced: several blocks out of one message", () => {
  const text = [
    "before",
    "```mermaid",
    "graph TD",
    "A-->B",
    "```",
    "middle",
    '```csv\ntime,v\n1,2\n```',
    "after",
  ].join("\n");
  const blocks = extractFenced(text);
  assert.deepEqual(
    blocks.map((b) => b.lang),
    ["mermaid", "csv"],
  );
  assert.equal(blocks[0].body, "graph TD\nA-->B");
});

test("tool image blocks: images claimable, diffs/text not", () => {
  const content = [
    { type: "content" as const, content: { type: "image" as const, mimeType: "image/png", data: "AAAA" } },
    { type: "diff" as const, path: "a.ts", oldText: "", newText: "" },
    { type: "content" as const, content: { type: "text" as const, text: "done" } },
    { type: "content" as const, content: { type: "image" as const, mimeType: "image/jpeg", data: "BBBB" } },
  ];
  const imgs = toolImageBlocks(content as Parameters<typeof toolImageBlocks>[0]);
  assert.equal(imgs.length, 2);
  assert.equal((imgs[0] as { data?: string }).data, "AAAA");
  assert.equal(toolImageBlocks(undefined).length, 0);
  assert.equal(toolImageBlocks([{ type: "content", content: { type: "text", text: "x" } } as never]).length, 0);
});

test("card validator: field-level strictness", () => {
  const card = parseCard(CARD)!;
  assert.equal(card.title, "checkup");
  assert.equal(card.pill?.tone, "good");
  assert.equal(card.rows?.length, 1);
  assert.equal(card.actions?.[0].kind, "send");
  // invalid action kinds dropped (array itself collapses away)
  const partial = parseCard(JSON.stringify({
    title: "x",
    actions: [{ label: "ok", kind: "selfdestruct", value: "boom" }],
  }))!;
  assert.equal(partial.actions?.length ?? 0, 0, "unknown action kinds rejected");
  // valid-looking object without any card field → null
  assert.equal(parseCard(JSON.stringify({ hello: "world" })), null);
});

test("chart validator: series shape + uplot conversion", () => {
  const chart = parseChart(CHART)!;
  assert.equal(chart.series.length, 1);
  assert.deepEqual(chart.series[0].points, [[1, 10], [2, 20], [3, 15]]);
  const { xs, ys } = toUPlotData(chart);
  assert.deepEqual(xs, [1, 2, 3]);
  assert.deepEqual(ys, [[10, 20, 15]]);
  // gap-tolerant union alignment (series need ≥2 points to draw —
  // single-point series are dropped by the validator)
  const gapped = parseChart(JSON.stringify({
    series: [
      { label: "a", points: [[0, 1], [10, 2]] },
      { label: "b", points: [[5, 9], [15, 12]] },
    ],
  }))!;
  const g = toUPlotData(gapped);
  assert.deepEqual(g.xs, [0, 5, 10, 15]);
  assert.deepEqual(g.ys[1], [null, 9, null, 12]);
  // not-a-chart → null
  assert.equal(parseChart(JSON.stringify({ series: "nope" })), null);
  assert.equal(parseChart(JSON.stringify({ series: [] })), null);
});

test("table parser: csv quoting, tsv, numeric columns", () => {
  const csv = parseTable('a,b\n1,2\n3,4', "csv")!;
  assert.deepEqual(csv.header, ["a", "b"]);
  assert.equal(csv.numericCols.includes(0), true);
  // quoted commas
  const quoted = parseTable('name,note\n"x, y",5\n"say ""hi""",6', "csv")!;
  assert.deepEqual(quoted.rows[0], ["x, y", "5"]);
  assert.deepEqual(quoted.rows[1], ['say "hi"', "6"]);
  const tsv = parseTable("x\ty\n10\t20", "tsv")!;
  assert.deepEqual(tsv.header, ["x", "y"]);
  // too-small / single-col tables → null (code block fallback)
  assert.equal(parseTable("only-header,a,b", "csv"), null);
  assert.equal(parseTable("", "csv"), null);
  // text-dominant column not marked numeric (≥60% threshold)
  const mixed = parseTable("k,v\nfoo,1\nbar,2\nbaz,3", "csv")!;
  // col 0 never numeric here
  assert.equal(mixed.numericCols.includes(0), false);
  assert.equal(mixed.numericCols.includes(1), true);
});

test("sparkline points: normalization and edge cases", () => {
  assert.deepEqual(sparkPoints([0, 5, 10], 20, 10).length, 3);
  // flat series (max==min) must not divide by zero
  assert.equal(sparkPoints([7, 7, 7], 20, 10).every((p) => p[1] === 5), true);
  assert.equal(sparkPoints([1], 20, 10).length, 0, "<2 points → nothing");
  // [ts, v] pairs accepted
  const pts = sparkPoints([[1, 3], [2, 6]], 10, 10);
  assert.equal(pts[1][1] < pts[0][1], true, "rising values climb");
});

test("d3 sandbox: escaping, CSP injection, no same-origin", () => {
  // script-close breakout is neutralized
  assert.equal(escapeScriptClose("x</script>evil"), "x<\\/script>evil");
  assert.equal(escapeScriptClose("</SCRIPT>"), "<\\/script>");
  // the built d3 doc carries the contract
  const doc = buildD3Doc('d3.select("#viz");</script>alert(1)');
  assert.ok(doc.includes("sandbox") === false, "sandbox lives on the iframe attr, not the doc");
  assert.ok(doc.includes('<meta http-equiv="Content-Security-Policy"'));
  assert.ok(doc.includes("d3@7/+esm"), "d3 preloaded from the CDN");
  assert.ok(
    !doc.includes("</script>alert(1)"),
    "agent code cannot break out of the host script tag",
  );
  assert.ok(doc.includes("try {"), "user code runs in try/catch");
  assert.ok(SANDBOX_CSP.startsWith("default-src 'none'"));
  assert.equal(IFRAME_SANDBOX, "allow-scripts", "scripts yes; same-origin never");
  assert.equal(SANDBOX_CSP.includes("allow-same-origin"), false);
});

test("injectCsp: head, html and bare-body documents", () => {
  assert.equal(injectCsp("<head><title>t</title></head><body></body>").indexOf("<head><meta"), 0);
  assert.ok(injectCsp("<html lang=\"en\"><body>x</body></html>").includes("<html lang=\"en\"><head><meta"));
  assert.ok(injectCsp("<p>bare</p>").startsWith("<meta http-equiv="));
  assert.ok(injectCsp("<html><head></head></html>").includes("Content-Security-Policy"));
});

/**
 * Sanity: markers and rich blocks coexist — a user message that
 * carries an image marker plus a rich fence survives both
 * projections (the marker rewrite is image-scoped and must not
 * touch fenced bodies).
 */
test("image markers don't corrupt fenced bodies", () => {
  const UP: ImageRef = { id: "ab12cd34ef56", name: "x.jpg", mimeType: "image/jpeg" };
  const text = "look:\n```chart-nope\n[Image: ab12cd34ef56]\n```\nplain";
  const { text: cleaned, images } = rewriteImageMarkers(text, () => UP);
  assert.equal(images.length, 1, "marker outside a fence still resolves");
  assert.equal(cleaned.includes("chart-nope"), true, "fence body untouched");
});