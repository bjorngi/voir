import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFinal, joinFor } from "../app/lib/dictation";

test("joinFor", () => {
  assert.equal(joinFor("", "hello"), "hello");
  assert.equal(joinFor("hello", ""), "hello");
  assert.equal(joinFor("hello", "world"), "hello world");
  assert.equal(joinFor("hello ", "world"), "hello world");
  assert.equal(joinFor("hello", " world"), "hello world");
});

test("appendFinal appends when there is no overlap", () => {
  assert.equal(appendFinal("", "hello world"), "hello world");
  assert.equal(appendFinal("hello", "world"), "hello world");
  assert.equal(
    appendFinal("what is voir", "please explain"),
    "what is voir please explain",
  );
});

test("appendFinal drops a fully repeated delivery", () => {
  // The same final delivered twice, or a restart re-capturing
  // exactly what was already committed.
  assert.equal(appendFinal("hello world", "hello world"), "hello world");
  assert.equal(
    appendFinal("what is voir", "what is voir"),
    "what is voir",
  );
});

test("appendFinal trims a partial re-capture overlap", () => {
  // Restart boundary: the new session re-heard "are you" before
  // the user continued.
  assert.equal(
    appendFinal("hello how are you", "are you doing today"),
    "hello how are you doing today",
  );
  // Single-word overlap still trims.
  assert.equal(
    appendFinal("what about", "about the tests"),
    "what about the tests",
  );
});

test("appendFinal matches overlap case/punctuation-insensitively", () => {
  // Recognizers re-punctuate re-deliveries differently.
  assert.equal(
    appendFinal("hello world.", "Hello, World how are you"),
    "hello world. how are you",
  );
  assert.equal(
    appendFinal("What is Voir?", "what is voir? please explain"),
    "What is Voir? please explain",
  );
});

test("appendFinal collapses cumulative deliveries", () => {
  // The failure mode reported from the phone: every "final" is
  // the entire transcript so far, not just the new words. Blind
  // appending turned this into "hello hello world hello world
  // how are you ...".
  let acc = "";
  for (const chunk of ["hello", "hello world", "hello world how are you"]) {
    acc = appendFinal(acc, chunk);
  }
  assert.equal(acc, "hello world how are you");
});

test("appendFinal interleaves genuine repetition with new words", () => {
  // Real cumulative deliveries mixed with segment restarts.
  let acc = "";
  for (const chunk of [
    "please add",
    "please add a test",
    "a test for the dictation lib",
  ]) {
    acc = appendFinal(acc, chunk);
  }
  assert.equal(acc, "please add a test for the dictation lib");
});

test("appendFinal documented trade-off: a genuinely repeated phrase loses its repeat", () => {
  // If the user genuinely repeats themselves (stuttering, or
  // deliberate emphasis) the repeat can be mistaken for a
  // re-delivery and trimmed. Accepted: dictation is a reviewable
  // draft, and under-duplication beats stuttering repetition.
  // Note the base is never edited — only the duplicated prefix of
  // the new material is dropped.
  assert.equal(
    appendFinal("I opened the", "the file exists"),
    "I opened the file exists",
  );
});