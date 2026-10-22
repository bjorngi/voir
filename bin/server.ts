#!/usr/bin/env node
// Voir production server.
//
// A WS-capable replacement for `react-router-serve`: normal
// requests (pages, the SSE chat stream, API routes) are handled
// by React Router's express adapter with the built bundle from
// build/server, while upgrades at /api/voice and /api/tts go to
// the streaming voice endpoints — the same attachVoiceServer /
// attachTtsServer the Vite dev server uses, so production and
// dev behave identically for voice mode and neural narration.
//
// Loads .env from the working directory first (shell env wins,
// matching the dev server's loader) — the production instance
// keeps its STT/TTS keys out of git the same way dev does.
//
// Usage:  PORT=10001 npm start      (package.json start = tsx bin/server.ts)

import express from "express";
import { createRequestHandler } from "@react-router/express";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { attachVoiceServer } from "../app/lib/voice-server.ts";
import { attachTtsServer } from "../app/lib/tts-server.ts";

// ---------------------------------------------------------------------
// .env — dotenv-style, shell env wins
// ---------------------------------------------------------------------

async function loadEnvFile() {
  const path = `${process.cwd()}/.env`;
  if (!existsSync(path)) return;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

await loadEnvFile();

// ---------------------------------------------------------------------
// HTTP + WS server
// ---------------------------------------------------------------------

const port = Number(process.env.PORT ?? 9000);
const host = process.env.HOST ?? "0.0.0.0";
const build = await import("../build/server/index.js");
const log = (msg: string) =>
  console.log(new Date().toISOString().slice(11, 19), msg);

const app = express();
// Static assets from the client build (JS/CSS chunks, the PWA
// manifest, service worker, icons, the pcm worklet). Falls
// through to the React Router handler for anything else.
app.use(express.static("build/client"));
// Express 5 changed catch-all path syntax; a bare use() matches
// everything without one.
app.use(createRequestHandler({ build, mode: "production" }));

const server = app.listen(port, host, () => {
  log(`voir serving build/client on ${host}:${port}`);
});

// Voice + neural TTS — the same endpoints the Vite dev server
// attaches (see vite.config.ts). Caddy proxies WebSockets
// transparently, so wss://chat.lab/api/voice works as-is.
const detachVoice = attachVoiceServer(server, log);
const detachTts = attachTtsServer(server, log);
log(
  `voice STT: ${process.env.VOICE_STT_PROVIDER ?? "mock"}` +
    `${process.env.VOICE_STT_PROVIDER === "deepgram" ? `/${process.env.VOICE_STT_MODEL ?? "nova-2"}` : ""}`,
);

const shutdown = () => {
  detachVoice();
  detachTts();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);