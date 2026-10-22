import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextNarrationChunk,
  stripMarkdown,
} from "../app/lib/narration";

function drain(raw: string, opts: { final: boolean }, from = 0) {
  let spoken = from;
  const out: string[] = [];
  for (;;) {
    const chunk = nextNarrationChunk(raw, spoken, opts);
    if (!chunk) return { out, spoken, stalled: true };
    spoken = chunk.spoken;
    if (chunk.text) out.push(chunk.text);
    if (spoken >= raw.length) return { out, spoken, stalled: false };
  }
}

test("stripMarkdown: formatting is removed, words kept", () => {
  assert.equal(stripMarkdown("Run `npm install` first."), "Run npm install first.");
  assert.equal(stripMarkdown("**Important:** do it now."), "Important: do it now.");
  assert.equal(stripMarkdown("Never use *that* flag."), "Never use that flag.");
  assert.equal(stripMarkdown("snake_case stays _intact_"), "snake_case stays intact");
  assert.equal(stripMarkdown("## Fixed the bug"), "Fixed the bug.");
  assert.equal(stripMarkdown("- first item\n- second item"), "first item second item");
  assert.equal(stripMarkdown("1. step one\n2. step two"), "step one step two");
  assert.equal(stripMarkdown("> quoted text"), "quoted text");
  assert.equal(stripMarkdown("See [the docs](https://example.com) here."), "See the docs here.");
  assert.equal(stripMarkdown("See https://example.com/page for more."), "See for more.");
  assert.equal(stripMarkdown("Look at an ![icon](https://x/y.png) here."), "Look at an icon here.");
  assert.equal(stripMarkdown("~~old~~ new"), "old new");
  assert.equal(stripMarkdown("a|b|c"), "a b c");
  assert.equal(stripMarkdown("| --- | --- |\nrow after"), "row after");
});

test("narration: plain sentences stream one by one", () => {
  const raw = "First sentence. Second sentence. Third without end";
  const a = nextNarrationChunk(raw, 0, { final: false });
  // Greedy to the LAST boundary — utterances pause naturally at
  // periods, and greed avoids cutting at abbreviations like
  // "e.g." — so complete sentences ride together per chunk.
  assert.equal(a?.text, "First sentence. Second sentence.");
  const b = nextNarrationChunk(raw, a!.spoken, { final: false });
  assert.equal(b, null); // tail still streaming
  const c = nextNarrationChunk(raw, a!.spoken, { final: true });
  assert.equal(c?.text, "Third without end");
  assert.equal(c?.spoken, raw.length);
});

test("narration: fenced code is skipped, prose around it speaks", () => {
  const raw =
    "Here is the plan. Now the code:\n" +
    "```ts\n" +
    "const x = 1; // do not read this\n" +
    "```\n" +
    "And that's how it works.";
  const r = drain(raw, { final: true });
  assert.deepEqual(r.out, [
    "Here is the plan.",
    "Now the code:",
    "And that's how it works.",
  ]);
  assert.equal(r.spoken, raw.length);
});

test("narration: streaming holds at an unterminated fence", () => {
  const raw = "Done. Now code:\n```ts\nconst x = 1;";
  const a = nextNarrationChunk(raw, 0, { final: false });
  assert.equal(a?.text, "Done.");
  const b = nextNarrationChunk(raw, a!.spoken, { final: false });
  // "Now code:" has no sentence end but a fence follows — flushed.
  assert.equal(b?.text, "Now code:");
  // Inside the open fence: hold.
  const c = nextNarrationChunk(raw, b!.spoken, { final: false });
  assert.equal(c, null);
  // On final, the unterminated code is swallowed, not spoken.
  const d = nextNarrationChunk(raw, b!.spoken, { final: true });
  assert.equal(d?.text, "");
  assert.equal(d?.spoken, raw.length);
});

test("narration: resume speaking after the fence closes mid-stream", () => {
  const open = "Intro sentence. ```js\ncode();";
  const a = nextNarrationChunk(open, 0, { final: false });
  assert.equal(a?.text, "Intro sentence.");
  assert.equal(nextNarrationChunk(open, a!.spoken, { final: false }), null);
  // The close arrives, then more prose streams in.
  const raw = open + "\n```\nAfterward: it worked.";
  const r = drain(raw, { final: false }, a!.spoken);
  assert.deepEqual(r.out, ["Afterward: it worked."]);
});

test("narration: code is never spoken even mid-message offsets", () => {
  const raw = "One.\n```\nhidden bytes\n```\nTwo.";
  const drained = drain(raw, { final: true });
  assert.ok(
    !drained.out.some((t) => t.includes("hidden")),
    "code content must never reach speech",
  );
  assert.deepEqual(drained.out, ["One.", "Two."]);
});

test("narration: prose flushed when a fence follows without punctuation", () => {
  const raw = "No period here:\n```sh\nls\n```\nDone.";
  const r = drain(raw, { final: true });
  assert.deepEqual(r.out, ["No period here:", "Done."]);
});

test("narration: offsets survive code between sentences", () => {
  const raw = "One.\n```py\nx = 1\n```\nTwo.";
  const a = nextNarrationChunk(raw, 0, { final: true });
  assert.equal(a?.text, "One.");
  // The next call must jump the whole fence, not speak its bytes.
  const b = nextNarrationChunk(raw, a!.spoken, { final: true });
  assert.equal(b?.text, "Two.");
  assert.equal(b?.spoken, raw.length);
});

test("narration: a message that is only code says nothing", () => {
  const raw = "```js\nconsole.log('silent');\n```\n";
  const r = drain(raw, { final: true });
  assert.deepEqual(r.out, []);
  assert.equal(r.spoken, raw.length);
});

test("narration: heading + bullet list narrate naturally", () => {
  const raw = "## Summary\n- Fixed the parser.\n- Added tests.";
  const r = drain(raw, { final: true });
  // One greedy chunk, but the heading gets an injected period so
  // the voice pauses: "Summary. Fixed the parser. Added tests."
  assert.deepEqual(r.out, ["Summary. Fixed the parser. Added tests."]);
});

test("narration: every result advances — no infinite loops", () => {
  const raw =
    "Text. ```\ncode\n```\nMore text, no end yet";
  let spoken = 0;
  for (let n = 0; n < 10; n++) {
    const c = nextNarrationChunk(raw, spoken, { final: true });
    if (!c) break;
    assert.ok(c.spoken > spoken, "must strictly advance");
    spoken = c.spoken;
    if (spoken >= raw.length) break;
  }
  assert.ok(spoken >= raw.length);
});