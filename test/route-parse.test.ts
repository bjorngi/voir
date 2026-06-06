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

test("parseRoute: folder + ?view=diff → diff for that folder", () => {
  assert.deepEqual(parseRoute("home/me/proj", "diff"), {
    k: "diff",
    folder: "/home/me/proj",
    sessionId: null,
  });
});

test("parseRoute: folder/s/<id> → chat for that session", () => {
  assert.deepEqual(parseRoute("home/me/proj/s/abc-123", null), {
    k: "chat",
    folder: "/home/me/proj",
    sessionId: "abc-123",
    diff: false,
  });
});

test("parseRoute: folder/s/<id>?view=diff → diff that preserves the session id", () => {
  // The chat's tab bar uses the preserved sessionId so a
  // "Back" affordance can return the user to the chat.
  assert.deepEqual(parseRoute("home/me/proj/s/abc-123", "diff"), {
    k: "diff",
    folder: "/home/me/proj",
    sessionId: "abc-123",
  });
});

test("parseRoute: folder name that is exactly 'd' does not collide with /d/<...>", () => {
  // A folder literally called "d" must still parse as a
  // sessions request, not as a malformed route.
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
  // The "s" segment must be second-to-last: .../s/<id>.
  // Trailing "s" with no id is malformed; treat as root.
  assert.deepEqual(parseRoute("home/me/proj/s", null), { k: "folders" });
});

test("parseRoute: extra segments after the session id fall back to the root view", () => {
  // .../s/<id>/extra — only <id> is allowed as the last
  // segment. Anything else is malformed.
  assert.deepEqual(parseRoute("home/me/proj/s/abc/extra", null), {
    k: "folders",
  });
});

test("parseRoute: paths with spaces survive a URL round-trip", () => {
  // encodeURI encodes spaces as %20, but the router hands
  // us the URL-decoded value. So an outbound folder URL
  // "/a b/c d" → "/f/a%20b/c%20d" arrives at the server as
  // splat = "a b/c d", and pathFromFolderParam re-adds the
  // leading slash.
  const splat = "a b/c d";
  assert.deepEqual(parseRoute(splat, null), {
    k: "sessions",
    folder: "/a b/c d",
  });
});
