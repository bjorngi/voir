import test from "node:test";
import assert from "node:assert/strict";
import { shortPath } from "../app/lib/format";

test("shortPath: short absolute path is returned unchanged", () => {
  assert.equal(shortPath("/"), "/");
  assert.equal(shortPath("/foo"), "/foo");
  assert.equal(shortPath("/foo/bar"), "/foo/bar");
});

test("shortPath: 3+ segments are abbreviated to the last two with a …/", () => {
  assert.equal(shortPath("/home/me/proj"), "…/me/proj");
  assert.equal(
    shortPath("/home/me/worktrees/feat-42"),
    "…/worktrees/feat-42",
  );
});

test("shortPath: trailing slashes are ignored", () => {
  // split("") → "foo", "bar", "" → filter(Boolean) drops "" → 2 parts
  assert.equal(shortPath("/foo/bar/"), "/foo/bar/");
});
