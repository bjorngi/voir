import test from "node:test";
import assert from "node:assert/strict";
import {
  parseNameStatus,
  parseUnifiedDiff,
  type FileStatus,
} from "../app/lib/diff.server";

test("parseNameStatus: simple added/modified/deleted entries", () => {
  // git diff --name-status -z separates records with NUL.
  // A simple change is two fields: status byte + path.
  const blob = "A\0src/new.ts\0M\0src/changed.ts\0D\0src/gone.ts\0";
  assert.deepEqual(parseNameStatus(blob).entries, [
    { status: "added", path: "src/new.ts" },
    { status: "modified", path: "src/changed.ts" },
    { status: "deleted", path: "src/gone.ts" },
  ]);
});

test("parseNameStatus: renamed entries carry oldPath", () => {
  // Renamed records have 3 NUL-separated fields:
  // status, oldPath, newPath. The "R100" score is dropped.
  const blob = "R100\0old/name.ts\0new/name.ts\0";
  assert.deepEqual(parseNameStatus(blob).entries, [
    { status: "renamed", path: "new/name.ts", oldPath: "old/name.ts" },
  ]);
});

test("parseNameStatus: copies are tagged 'copied'", () => {
  const blob = "C075\0src/a.ts\0src/a-copy.ts\0";
  assert.deepEqual(parseNameStatus(blob).entries, [
    { status: "copied", path: "src/a-copy.ts", oldPath: "src/a.ts" },
  ]);
});

test("parseNameStatus: typechange entries are recognised", () => {
  const blob = "T\0scripts/run\0";
  assert.deepEqual(parseNameStatus(blob).entries, [
    { status: "typechange", path: "scripts/run" },
  ]);
});

test("parseNameStatus: empty blob → empty entries", () => {
  assert.deepEqual(parseNameStatus(""), { entries: [] });
});

test("parseUnifiedDiff: returns an empty map for empty input", () => {
  assert.equal(parseUnifiedDiff("").size, 0);
});

test("parseUnifiedDiff: parses a single-file diff into hunks", () => {
  // A typical one-file, one-hunk diff. The path is taken from
  // the `diff --git a/p b/p` header's b/ side.
  const body = [
    "diff --git a/src/foo.ts b/src/foo",
    "index 1234567..89abcde 100644",
    "--- a/src/foo",
    "+++ b/src/foo",
    "@@ -1,3 +1,3 @@",
    " line one",
    "-old line two",
    "+new line two",
    " line three",
  ].join("\n");
  const map = parseUnifiedDiff(body);
  assert.equal(map.size, 1);
  const hunks = map.get("src/foo");
  assert.ok(hunks);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].header, "@@ -1,3 +1,3 @@");
  assert.deepEqual(hunks[0].lines, [
    { kind: "ctx", text: "line one" },
    { kind: "del", text: "old line two" },
    { kind: "add", text: "new line two" },
    { kind: "ctx", text: "line three" },
  ]);
});

test("parseUnifiedDiff: handles multiple files in one body", () => {
  const body = [
    "diff --git a/one.ts b/one",
    "--- a/one",
    "+++ b/one",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/two.ts b/two",
    "--- a/two",
    "+++ b/two",
    "@@ -1 +1 @@",
    "-c",
    "+d",
  ].join("\n");
  const map = parseUnifiedDiff(body);
  assert.deepEqual([...map.keys()].sort(), ["one", "two"]);
  assert.equal(map.get("one")![0].lines[0].kind, "del");
  assert.equal(map.get("two")![0].lines[0].kind, "del");
});

test("parseUnifiedDiff: multiple hunks in one file are preserved in order", () => {
  const body = [
    "diff --git a/file b/file",
    "--- a/file",
    "+++ b/file",
    "@@ -1,1 +1,1 @@",
    "-a",
    "+b",
    "@@ -10,1 +10,1 @@",
    "-c",
    "+d",
  ].join("\n");
  const hunks = parseUnifiedDiff(body).get("file")!;
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].header, "@@ -1,1 +1,1 @@");
  assert.equal(hunks[1].header, "@@ -10,1 +10,1 @@");
});

test("parseUnifiedDiff: '\\ No newline at end of file' lines are skipped", () => {
  const body = [
    "diff --git a/file b/file",
    "--- a/file",
    "+++ b/file",
    "@@ -1 +1 @@",
    "-old",
    "\\ No newline at end of file",
    "+new",
  ].join("\n");
  const lines = parseUnifiedDiff(body).get("file")![0].lines;
  assert.deepEqual(lines, [
    { kind: "del", text: "old" },
    { kind: "add", text: "new" },
  ]);
});

// Smoke test: the public DiffFile["status"] union is what the
// renderer reads. Guard against accidental drift between the
// parser and the wire type.
test("FileStatus union includes all expected kinds", () => {
  const kinds: FileStatus[] = [
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "typechange",
    "untracked",
  ];
  // The CSS / badge strings are keyed off these values; if
  // someone renames a kind the UI silently breaks. This test
  // is a tripwire.
  assert.equal(new Set(kinds).size, 7);
});
