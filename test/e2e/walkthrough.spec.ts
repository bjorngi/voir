import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * Redesign walkthrough — the narrative a redesign has to keep
 * working, driven end to end against the mock stack
 * (bin/dev.mjs: vite + mock-a/mock-b with distinct seed sets).
 *
 * One file, one order, one shared stack (workers: 1 in
 * playwright.config.ts): home → folder list → seeded transcript →
 * live turn → every rich module → model drawer → new chat →
 * archive → the other folder's distinct seeds → back home.
 *
 * Selectors lean on roles, labels and the render modules' own
 * data-testids — not on layout or class names — so a redesign
 * that keeps the affordances passes without edits. When a
 * selector here HAS to change, that's the smoke alarm going
 * off about a lost affordance, not test churn.
 *
 * Three voir-specific matching facts these locators respect:
 *
 *  - Folder rows display shortPath() ("…/dev-data/project-a"),
 *    and "Working on" rows show title + path + age, so folder
 *    links are matched by their exact short name to stay unique.
 *  - A session that is in "Working on" carries a tooltip on its
 *    row ("Active — in Working on …") that becomes part of the
 *    link's accessible name — session links are matched by
 *    substring, never exactly.
 *  - Dev mode hydrates slowly (vite serves unbundled modules),
 *    and SSR content is visible before React attaches handlers.
 *    After every full-page navigation we wait for networkidle
 *    before interacting, or clicks land on dead SSR buttons.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// bin/dev.mjs copies the pristine samples into dev-data/worktrees/ and
// builds the fixture repos there (the samples themselves stay clean), so
// these are the paths the agent registers and the UI shows.
const FOLDER_A = `${ROOT}/dev-data/worktrees/project-a`;
const FOLDER_B = `${ROOT}/dev-data/worktrees/project-b`;

// Mirrors app/lib/format.ts shortPath() — what the folder rows
// actually render as their accessible names.
function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 2 ? p : "…/" + parts.slice(-2).join("/");
}
const SHORT_A = shortPath(FOLDER_A);
const SHORT_B = shortPath(FOLDER_B);

// The stack may still be registering the mock agents when the
// first test runs (the webServer health URL answers before
// registration lands). Reload until the folder tree answers,
// then let dev-mode hydration settle before any interaction.
async function gotoHome(page: Page) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    await page.goto("/");
    if (
      (await page.getByRole("link", { name: SHORT_A, exact: true }).count()) >
      0
    ) {
      break;
    }
    if (Date.now() > deadline)
      throw new Error("mock folders never appeared on the home view");
    await page.waitForTimeout(1_000);
  }
  await page.waitForLoadState("networkidle");
}

// Open a folder's sessions view, waiting for one of its seed
// titles so the list is known to be rendered.
async function openFolder(page: Page, short: string, probe: string) {
  await gotoHome(page);
  await page.getByRole("link", { name: short, exact: true }).click();
  // The click may hydrate into a client-side navigation or fall
  // back to a full document navigation — settle either way.
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("link", { name: probe })).toBeVisible();
}

// Open a seeded session inside a folder and wait for its
// replayed transcript (the mock streams history on session/load,
// ~30ms per event — the needle is near the end of the seed).
async function openSession(
  page: Page,
  short: string,
  probe: string,
  needle: string,
) {
  await openFolder(page, short, probe);
  await page.getByRole("link", { name: probe }).click();
  await expect(page.getByText(needle)).toBeVisible();
}

// Type into the composer and send; the mock echoes the prompt as
// a thought and streams a canned reply.
//
// Sending goes through ⌘/Ctrl+Enter rather than the Send button on
// purpose: the button is `sm:hidden` (mobile-only) and the composer's
// own placeholder tells desktop users to use the shortcut — so this
// helper is the one send path that exists on all three displays,
// including the 4:3 inner pane and the laptop.
async function sendAndWaitForTurn(page: Page, text: string) {
  // The mock keeps its transcript across the display projects (one
  // shared stack, one shared agent process), so the same prompt would
  // match twice in a later project and every text assertion would hit
  // strict-mode ambiguity. Tagging the message with the project name
  // keeps each run's text unique.
  const tagged = `${text} [${test.info().project.name}]`;
  const composer = page.locator("textarea").first();
  const echo = page.getByText(`You said: "${tagged}"`);

  // Dev mode serves unbundled modules, so SSR markup is interactive
  // well before React hydrates. A keystroke in that window fills the
  // DOM but never reaches the composer's handler — and hydration then
  // resets the value (the app is fine; the emulation is slow). Retry
  // fill + send until the agent echoes the prompt, which is the proof
  // that the whole path ran.
  await expect(async () => {
    if ((await echo.count()) > 0) return; // a previous attempt landed
    if ((await composer.inputValue()) !== tagged) {
      await composer.fill(tagged);
      await expect(composer).toHaveValue(tagged, { timeout: 2_000 });
    }
    await composer.press("Control+Enter");
    await expect(echo.first()).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 40_000, intervals: [500, 1_000, 2_000] });

  // The composer placeholder flipping back to the idle text is the
  // "turn settled" proof (it reads "Type to queue…" while busy).
  // Asserting that instead of a canned reply keeps this independent
  // of which reply the mock rotates to next.
  await expect(
    page.locator('textarea[placeholder^="Message…"]').first(),
  ).toBeVisible({ timeout: 20_000 });
}

/**
 * No horizontal overflow.
 *
 * This is the aspect-ratio assertion: the three review targets are
 * wildly different shapes (10:16 tall, 4:3 landscape, 16:10 wide),
 * and a layout that assumes one of them tends to leak sideways on
 * the others — a fixed-width pane, a non-wrapping tool row, a plot
 * that sizes to content. One CSS pixel of slack absorbs sub-pixel
 * rounding (deviceScaleFactor 3 splits a lot of thirds).
 */
async function expectNoHorizontalOverflow(page: Page, where: string) {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow, `${where}: content overflows horizontally by ${overflow}px`)
    .toBeLessThanOrEqual(1);
}

// -----------------------------------------------------------------------

test("home — Working on shortlist and both mock folders", async ({ page }) => {
  await gotoHome(page);

  await expect(page.locator("header").getByText("Folders")).toBeVisible();

  // The session-status preseed (bin/dev.mjs) gives the shortlist
  // one active session per folder on first paint.
  const working = page.locator('section[aria-label="Working on"]').first();
  await expect(working.getByText("Rich content tour")).toBeVisible();
  await expect(working.getByText("What is Voir?")).toBeVisible();

  // Both mock agents registered, with their agent chips.
  await expect(
    page.getByRole("link", { name: SHORT_A, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: SHORT_B, exact: true }),
  ).toBeVisible();
  await expect(page.getByText("mock-a", { exact: true })).toBeVisible();
  await expect(page.getByText("mock-b", { exact: true })).toBeVisible();

  await expectNoHorizontalOverflow(page, "home");
});

test("folder — seed session list, + New chat, archived reveal", async ({ page }) => {
  await openFolder(page, SHORT_A, "What is Voir?");

  // Variant-a seeds (shared + a-extras).
  for (const title of [
    "What is Voir?",
    "Rich content tour",
    "Fix flaky E2E tests",
    "Refactor auth middleware",
    "Triage the task list",
  ]) {
    await expect(page.getByRole("link", { name: title })).toBeVisible();
  }
  await expect(page.getByText("+ New chat")).toBeVisible();

  // The preseeded archived session is hidden until revealed.
  const health = page.getByRole("link", { name: "Add a /health endpoint" });
  await expect(health).toHaveCount(0);
  await page.getByText("Show archived (1)").click();
  await expect(health).toBeVisible();
  await expect(page.getByText("Hide archived")).toBeVisible();

  await expectNoHorizontalOverflow(page, "sessions list");
});

test("transcript — seeded history replays on open", async ({ page }) => {
  await openSession(
    page,
    SHORT_A,
    "What is Voir?",
    "ACP-compatible coding agents",
  );

  // User turn, agent prose, a thought, and a tool call all
  // survived the replay. (Tool content renders collapsed — the
  // tool's own content text is NOT visible until expanded.)
  await expect(page.getByText("I'm new here.")).toBeVisible();
  await expect(
    page.getByText("talks JSON-RPC 2.0 to whatever agent you point it at"),
  ).toBeVisible();
  await expect(page.getByText("Read README.md")).toBeVisible();

  await expectNoHorizontalOverflow(page, "chat transcript");
});

test("turn — sending a message streams the mock's echo", async ({ page }) => {
  await openSession(
    page,
    SHORT_A,
    "Fix flaky E2E tests",
    "dynamic allocation",
  );
  await sendAndWaitForTurn(page, "hello walkthrough");
});

test("rich — the content tour renders every module", async ({ page }) => {
  await openSession(
    page,
    SHORT_A,
    "Rich content tour",
    "hiet checkup 2026-11-04",
  );

  // mermaid → svg, chart → uPlot canvas, csv → table, card →
  // title + pill + rows, ha: chip, d3 + html → sandboxed frames.
  await expect(page.getByTestId("mermaid-svg").locator("svg")).toBeVisible();
  await expect(page.getByTestId("chart-plot").locator("canvas")).toBeVisible();
  await expect(page.getByTestId("rich-table").getByRole("columnheader", { name: "cpu" })).toBeVisible();
  await expect(page.getByText("disk /")).toBeVisible();
  await expect(page.getByText("healthy", { exact: true })).toBeVisible();
  await expect(page.getByTestId("ha-chip")).toBeVisible();
  await expect(page.locator('iframe[sandbox="allow-scripts"]')).toHaveCount(2);

  // The sandboxed html app is alive: the counter button works
  // across the frame boundary.
  const frame = page.frameLocator('[data-testid="html-frame"]');
  await expect(frame.getByText("counter (sandboxed)")).toBeVisible();
  await frame.getByRole("button", { name: "+1" }).click();
  await expect(frame.getByText("n = 1")).toBeVisible();

  // Widest content in the app: a chart, a table and two sandboxed
  // frames. A 4:3 pane that clips any of them leaks sideways here.
  await expectNoHorizontalOverflow(page, "rich content");
});

test("model sheet — grip opens it, model switch, vision marker", async ({ page }) => {
  await openSession(
    page,
    SHORT_A,
    "What is Voir?",
    "ACP-compatible coding agents",
  );

  // The sheet opens from the grip strip under the field (tap; swipe up does
  // the same). The grip also prints the live model · mode.
  const grip = page.getByRole("button", { name: "Open model, mode and fence" });
  await expect(grip).toContainText("cheery-1");
  await grip.click();

  const sheet = page.getByRole("dialog", { name: "Model, mode and fence" });
  await expect(sheet).toBeVisible();
  const model = sheet.locator("select").first();
  await expect(model).toHaveValue("mock/cheery-1");
  // Cheery is vision-capable — the sheet says so.
  await expect(page.getByTestId("drawer-vision")).toContainText("Images ✓");

  // Switching a model applies and closes the sheet (the turn is the user's,
  // not a settings screen to linger in)…
  await model.selectOption("mock/cryptic-2");
  await expect(sheet).toHaveCount(0);
  await expect(grip).toContainText("cryptic-2");
  // …and the next open shows the agent's truth: cryptic is text-only.
  await grip.click();
  await expect(page.getByTestId("drawer-vision")).toContainText("Images ✗");
  // Escape closes it (no ✕ hunting needed).
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Model, mode and fence" })).toHaveCount(0);
});

test("new chat — empty session takes a first turn", async ({ page }) => {
  await openFolder(page, SHORT_A, "What is Voir?");
  await page.getByText("+ New chat").click();
  // The new-chat form POST is a full document navigation.
  await page.waitForLoadState("networkidle");

  // Landed in a fresh chat: the composer is ready.
  await expect(page.locator("textarea").first()).toBeVisible();
  await sendAndWaitForTurn(page, "first turn");
});

// How many sessions the folder list currently hides as archived.
// Handles both toggle states: the button reads "Show archived (n)"
// normally, but "Hide archived" once revealed — in which case the
// archived rows are in the DOM and their Unarchive actions count.
async function archivedCount(page: Page): Promise<number> {
  const reveal = page.getByRole("button", { name: /^(Show|Hide) archived/ });
  if ((await reveal.count()) === 0) return 0;
  const label = (await reveal.first().textContent())?.trim() ?? "";
  if (label.startsWith("Hide archived")) {
    return await page.getByLabel("Unarchive").count();
  }
  return Number(label.match(/\((\d+)\)/)?.[1] ?? 0);
}

test("archive — row action hides a session until revealed", async ({ page }) => {
  await openFolder(page, SHORT_A, "What is Voir?");

  // Compare against the measured baseline rather than a hard-coded
  // number: the stack's preseed owns that count, and this test must
  // leave the store exactly as it found it (see the restore below).
  const baseline = await archivedCount(page);

  // The archive button overlays the row as a sibling of the
  // link, so scope to the row's <li>.
  const triageLink = page.getByRole("link", { name: "Triage the task list" });
  const row = page.locator("li").filter({ has: triageLink });
  await row.getByLabel("Archive").click();

  // Optimistic: the row drops and the reveal's count grows by one.
  await expect(triageLink).toHaveCount(0);
  expect(await archivedCount(page)).toBe(baseline + 1);

  // Reveal shows it as archived, with the inverse row action…
  await page
    .getByRole("button", { name: /^Show archived \(\d+\)$/ })
    .click();
  const archivedRow = page.locator("li").filter({ has: triageLink });
  await expect(archivedRow.getByLabel("Unarchive")).toBeVisible();

  // …and unarchiving puts it back: the test leaves the store the way
  // it found it, because the projects for the other two displays walk
  // this same stack and a leaked "archived" would break their list
  // assertions.
  await archivedRow.getByLabel("Unarchive").click();
  await expect(triageLink).toBeVisible();
  expect(await archivedCount(page)).toBe(baseline);
});

test("folder b — distinct seed set (variant b)", async ({ page }) => {
  await openFolder(page, SHORT_B, "Parse CSV edge cases");

  for (const title of [
    "Parse CSV edge cases",
    "Sandbox escape hatches",
    "Audit sample data",
  ]) {
    await expect(page.getByRole("link", { name: title })).toBeVisible();
  }
  // Variant-a extras must not leak into folder b.
  await expect(
    page.getByRole("link", { name: "Refactor auth middleware" }),
  ).toHaveCount(0);

  // Open the parse session: the csv table and the inline diff of
  // the edit tool render in the replayed transcript (edit tools
  // render their diff inline — no collapsed tool button).
  await page.getByRole("link", { name: "Parse CSV edge cases" }).click();
  await expect(
    page.getByText("state machine: track quote state"),
  ).toBeVisible();
  await expect(
    page.getByTestId("rich-table").getByRole("columnheader", { name: "rows in" }),
  ).toBeVisible();
});

test("tabs — Files and Changes render without sideways leak", async ({ page }) => {
  await openSession(
    page,
    SHORT_A,
    "What is Voir?",
    "ACP-compatible coding agents",
  );

  await page.getByRole("link", { name: "Files" }).click();
  await expect(page.locator("main")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expectNoHorizontalOverflow(page, "files tab");

  await page.getByRole("link", { name: "Changes" }).click();
  await page.waitForLoadState("networkidle");
  await expect(page.locator("main")).toBeVisible();
  await expectNoHorizontalOverflow(page, "changes tab");
});

test("navigate — back to folders from a chat", async ({ page }) => {
  await openSession(
    page,
    SHORT_A,
    "What is Voir?",
    "ACP-compatible coding agents",
  );
  await page.getByLabel("Back to folders").click();
  await expect(page.locator("header").getByText("Folders")).toBeVisible();
  await expect(
    page.getByRole("link", { name: SHORT_B, exact: true }),
  ).toBeVisible();
});
