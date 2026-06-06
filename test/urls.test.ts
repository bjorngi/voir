import test from "node:test";
import assert from "node:assert/strict";
import {
  folderUrl,
  sessionUrl,
  streamUrl,
  pathFromFolderParam,
} from "../app/lib/urls";

test("folderUrl: encodes path and drops leading slash", () => {
  assert.equal(folderUrl("/home/me/worktrees/feat-42"), "/f/home/me/worktrees/feat-42");
});

test("folderUrl: preserves slashes inside the path", () => {
  // encodeURI keeps "/" but encodes characters that need
  // escaping. A path of "/a b/c d" should have its spaces
  // turned into %20.
  assert.equal(folderUrl("/a b/c d"), "/f/a%20b/c%20d");
});

test("sessionUrl: appends /s/<id> to the folder url", () => {
  assert.equal(
    sessionUrl("/home/me/proj", "abc-123"),
    "/f/home/me/proj/s/abc-123",
  );
});

test("streamUrl: encodes folder as a query param", () => {
  assert.equal(
    streamUrl("/home/me/proj", "abc-123"),
    "/api/sessions/abc-123/stream?folder=%2Fhome%2Fme%2Fproj",
  );
});

test("pathFromFolderParam: re-adds a leading slash", () => {
  assert.equal(
    pathFromFolderParam("home/me/worktrees/feat-42"),
    "/home/me/worktrees/feat-42",
  );
  // Already-prefixed slashes are normalised to a single one
  assert.equal(
    pathFromFolderParam("///home/me"),
    "/home/me",
  );
});

test("folderUrl + pathFromFolderParam round-trip", () => {
  const path = "/home/me/worktrees/feat-42";
  // The URL we build is "/f/home/me/worktrees/feat-42"; the
  // router hands us "home/me/worktrees/feat-42" as the splat
  // value (already URL-decoded), and pathFromFolderParam
  // restores the leading slash.
  const fromUrl = folderUrl(path).slice("/f/".length);
  assert.equal(pathFromFolderParam(fromUrl), path);
});
