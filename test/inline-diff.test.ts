import test from "node:test";
import assert from "node:assert/strict";
import { buildInlineDiff } from "../app/lib/inline-diff";

test("buildInlineDiff: identical inputs produce all-context output", () => {
  const lines = buildInlineDiff("a\nb\nc", "a\nb\nc");
  assert.deepEqual(lines, [
    { kind: "ctx", text: "a" },
    { kind: "ctx", text: "b" },
    { kind: "ctx", text: "c" },
  ]);
});

test("buildInlineDiff: empty old → all adds", () => {
  const lines = buildInlineDiff("", "a\nb");
  assert.deepEqual(lines, [
    { kind: "add", text: "a" },
    { kind: "add", text: "b" },
  ]);
});

test("buildInlineDiff: empty new → all deletes", () => {
  const lines = buildInlineDiff("a\nb", "");
  assert.deepEqual(lines, [
    { kind: "del", text: "a" },
    { kind: "del", text: "b" },
  ]);
});

test("buildInlineDiff: an empty input is zero lines, not one", () => {
  // The string-level "".split("\n") quirk returns [""]
  // (one empty line). The diff treats that as zero lines so
  // an empty file renders as no lines, not as a single
  // blank line.
  assert.deepEqual(buildInlineDiff("", ""), []);
});

test("buildInlineDiff: a single-line change is a del + add", () => {
  const lines = buildInlineDiff("a\nb\nc", "a\nB\nc");
  assert.deepEqual(lines, [
    { kind: "ctx", text: "a" },
    { kind: "del", text: "b" },
    { kind: "add", text: "B" },
    { kind: "ctx", text: "c" },
  ]);
});

test("buildInlineDiff: an inserted line is a single add between context", () => {
  const lines = buildInlineDiff("a\nc", "a\nb\nc");
  assert.deepEqual(lines, [
    { kind: "ctx", text: "a" },
    { kind: "add", text: "b" },
    { kind: "ctx", text: "c" },
  ]);
});

test("buildInlineDiff: a deleted line is a single del between context", () => {
  const lines = buildInlineDiff("a\nb\nc", "a\nc");
  assert.deepEqual(lines, [
    { kind: "ctx", text: "a" },
    { kind: "del", text: "b" },
    { kind: "ctx", text: "c" },
  ]);
});

test("buildInlineDiff: a trailing newline in the input collapses to the same lines", () => {
  // "a\n" and "a" describe the same file (one line). The
  // diff treats them identically.
  const lines = buildInlineDiff("a\n", "a");
  assert.deepEqual(lines, [{ kind: "ctx", text: "a" }]);
});

test("buildInlineDiff: every output line is ctx, add, or del", () => {
  // Tripwire for the discriminated union — if someone adds a
  // new kind they have to update the renderer's color table.
  const lines = buildInlineDiff("a\nb\nc", "a\nB\nC\nd");
  for (const l of lines) {
    assert.ok(["ctx", "add", "del"].includes(l.kind), `unexpected kind ${l.kind}`);
  }
});
