import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UtteranceSegmenter,
  rmsOfInt16,
} from "../app/lib/voice-segmenter";

const F = 10; // frame ms

test("segmenter: silence alone produces nothing", () => {
  const seg = new UtteranceSegmenter({ frameMs: F, speechRms: 0.01, silenceMs: 700 });
  const events = [];
  for (let i = 0; i < 200; i++) events.push(...seg.feed(0)); // 2s silence
  assert.deepEqual(events, []);
  assert.equal(seg.sawSpeech, false);
});

test("segmenter: speech then silence yields start then utterance_end", () => {
  const seg = new UtteranceSegmenter({ frameMs: F, speechRms: 0.01, silenceMs: 700 });
  const events = [];
  for (let i = 0; i < 50; i++) events.push(...seg.feed(0.05)); // 500ms speech
  // exactly 700ms of silence to trigger the end
  for (let i = 0; i < 70; i++) events.push(...seg.feed(0));
  assert.equal(events[0]?.type, "speech_start");
  assert.equal(events.length, 2);
  assert.equal(events[1]?.type, "utterance_end");
  assert.equal(seg.sawSpeech, true);
});

test("segmenter: briefer silence does not end the utterance", () => {
  const seg = new UtteranceSegmenter({ frameMs: F, speechRms: 0.01, silenceMs: 700 });
  const events = [];
  for (let i = 0; i < 30; i++) events.push(...seg.feed(0.05)); // 300ms speech
  for (let i = 0; i < 50; i++) events.push(...seg.feed(0)); // 500ms pause
  for (let i = 0; i < 30; i++) events.push(...seg.feed(0.05)); // 300ms speech
  // Only one speech_start; the pause was too short to end it.
  assert.deepEqual(
    events.map((e) => e.type),
    ["speech_start"],
  );
});

test("rmsOfInt16: silence is zero, full-scale is one", () => {
  const silence = new Int16Array(240).fill(0);
  assert.equal(rmsOfInt16(silence), 0);
  const loud = new Int16Array(240).fill(32767);
  assert.ok(Math.abs(rmsOfInt16(loud) - 1) < 0.001);
  const quiet = new Int16Array(240).fill(1000); // ~0.03 normalized
  assert.ok(rmsOfInt16(quiet) > 0.02 && rmsOfInt16(quiet) < 0.04);
});