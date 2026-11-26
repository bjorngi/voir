import { defineConfig } from "@playwright/test";
import { DISPLAYS } from "./test/displays";

/**
 * End-to-end walkthrough config (test/e2e/*.spec.ts).
 *
 * The suite runs against the same one-command mock stack as
 * interactive redesign work (`npm run dev:mock`, bin/dev.mjs):
 * vite dev server + two mock ACP agents with distinct, pre-
 * seeded session sets. The stack is started by Playwright on a
 * dedicated port (9300) so it never collides with an interactive
 * dev:mock on 9000, and never touches production state —
 * bin/dev.mjs isolates VOIR_DATA_DIR before anything spawns.
 *
 * One project per display in test/displays.ts, so a single
 * `npm run test:e2e` walks the app on all three targets:
 *
 *   fold-cover   416×657    the 10:16 outer pane
 *   fold-inner   816×609    the 4:3 inner pane (landscape)
 *   laptop      1440×900   16:10
 *
 * Sequential on purpose: the walkthrough is one narrative through
 * the app (home → folder → transcript → reply → rich content →
 * drawer → new chat → archive → other folder), the mock agents are
 * shared in-memory state, and the projects share one dev server.
 * Tests therefore clean up after themselves (see the archive test)
 * so an earlier display's run cannot change what a later one sees.
 */
export default defineConfig({
  testDir: "./test/e2e",
  timeout: 60_000,
  expect: {
    // Dev-server first-paint (vite cold compile) can be slow;
    // everything else settles in well under this.
    timeout: 15_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:9300",
    // Failure traces are the review artifact: DOM snapshots per
    // step, plus screenshots (see `npx playwright show-trace`).
    trace: "retain-on-failure",
  },
  projects: DISPLAYS.map((d) => ({
    name: d.id,
    use: {
      viewport: { width: d.width, height: d.height },
      deviceScaleFactor: d.dpr,
      hasTouch: d.touch,
      isMobile: d.touch,
    },
  })),
  webServer: {
    // --fresh wipes the isolated runtime dir first, so every suite
    // run starts from the same seeded state (the session-status
    // overlay otherwise accumulates across runs — the archive test
    // would meet its own leftovers).
    command: "node bin/dev.mjs --port 9300 --fresh",
    url: "http://127.0.0.1:9300/api/folders",
    // dev.mjs only reports "up" once both mock agents registered,
    // but this health URL answers as soon as vite listens —
    // tests still poll for the folders themselves (see the
    // walkthrough's gotoHome helper) to bridge the gap.
    timeout: 180_000,
    // Always a fresh stack: the mocks hold created sessions in
    // memory, and a reused server would leak them into the
    // next run's list assertions.
    reuseExistingServer: false,
    stdout: "pipe",
  },
});
