import test from "node:test";
import assert from "node:assert/strict";
import { parseRoute } from "../app/lib/route-parse";

test("parseRoute: empty splat → folders view", () => {
  assert.deepEqual(parseRoute(undefined, null), { k: "folders" });
  assert.deepEqual(parseRoute("", null), { k: "folders" });
});

test("parseRoute: simple folder path → sessions", () => {
  assert.deepEqual(parseRoute("home/me/proj", null), {
    k: "sessions",
    folder: "/home/me/proj",
  });
});

test("parseRoute: folder + ?view=changes → changes for that folder", () => {
  assert.deepEqual(parseRoute("home/me/proj", "changes"), {
    k: "changes",
    folder: "/home/me/proj",
    sessionId: null,
  });
});

test("parseRoute: legacy ?view=diff maps to changes for that folder", () => {
  assert.deepEqual(parseRoute("home/me/proj", "diff"), {
    k: "changes",
    folder: "/home/me/proj",
    sessionId: null,
  });
});

test("parseRoute: folder/s/<id> → chat for that session", () => {
  assert.deepEqual(parseRoute("home/me/proj/s/abc-123", null), {
    k: "chat",
    folder: "/home/me/proj",
    sessionId: "abc-123",
  });
});

test("parseRoute: folder/s/<id>?view=changes → changes that preserves the session id", () => {
  assert.deepEqual(parseRoute("home/me/proj/s/abc-123", "changes"), {
    k: "changes",
    folder: "/home/me/proj",
    sessionId: "abc-123",
  });
});

test("parseRoute: legacy ?view=timeline maps to changes that preserves the session id", () => {
  assert.deepEqual(parseRoute("home/me/proj/s/abc-123", "timeline"), {
    k: "changes",
    folder: "/home/me/proj",
    sessionId: "abc-123",
  });
});

test("parseRoute: folder + ?view=timeline maps to changes for that folder", () => {
  assert.deepEqual(parseRoute("home/me/proj", "timeline"), {
    k: "changes",
    folder: "/home/me/proj",
    sessionId: null,
  });
});

test("parseRoute: folder/s/<id>?view=diff → changes that preserves the session id", () => {
  assert.deepEqual(parseRoute("home/me/proj/s/abc-123", "diff"), {
    k: "changes",
    folder: "/home/me/proj",
    sessionId: "abc-123",
  });
});

test("parseRoute: folder name that is exactly 'd' does not collide with /d/<...>", () => {
  assert.deepEqual(parseRoute("d", null), {
    k: "sessions",
    folder: "/d",
  });
  assert.deepEqual(parseRoute("home/me/d", null), {
    k: "sessions",
    folder: "/home/me/d",
  });
});

test("parseRoute: a folder/s/ without an id falls back to the root view", () => {
  assert.deepEqual(parseRoute("home/me/proj/s", null), { k: "folders" });
});

test("parseRoute: extra segments after the session id fall back to the root view", () => {
  assert.deepEqual(parseRoute("home/me/proj/s/abc/extra", null), {
    k: "folders",
  });
});

test("parseRoute: paths with spaces survive a URL round-trip", () => {
  const splat = "a b/c d";
  assert.deepEqual(parseRoute(splat, null), {
    k: "sessions",
    folder: "/a b/c d",
  });
});
