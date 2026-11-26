#!/usr/bin/env node
// shots — capture every view of the running Voir stack as a
// reviewable gallery of screenshots.
//
//   npm run shots                 (stack must be up: npm run dev:mock)
//   npm run shots -- --url http://127.0.0.1:9300
//   npm run shots:serve           (serve the latest run on the tailnet)
//
// Why: a redesign has to be reviewed page by page, at both phone
// and desktop widths, without clicking through the app every time.
// This walker opens each view, screenshots it, and writes a contact
// sheet (index.html) you can open on any device. Runs are
// timestamped under shots/<ts>/, so before/after comparisons are
// two browser tabs side by side.
//
// Views captured per display (see test/displays.ts):
//   home            the "Working on" shortlist + folder tree
//   folder-a        sessions list for the first mock folder
//   chat-top/btm    a seeded transcript (top and bottom)
//   rich-top/btm    the rich-content tour (modules + sandbox tail)
//   drawer          the model/mode/fence drawer open
//   picker          the global menu (folder/session switcher)
//   files           the Files tab
//   changes         the Changes (diff) tab
//   folder-b        the second mock folder (variant-b seeds)
//   chat-b          a transcript from the second folder
//
// Session ids are discovered from the pages themselves (the mock's
// seed ids are variant-namespaced and not worth hardcoding), so the
// walker works against any agent that has sessions in the folder.

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium, type Browser, type Page } from "@playwright/test";
import { DISPLAYS, displaySummary } from "../test/displays";
import { writeGallery } from "../tools/gallery/gallery";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── args ────────────────────────────────────────────────────────────
function parseArgs(argv: string[]) {
  const opts: {
    url: string;
    out: string | null;
    only: string | null;
    publish: boolean;
  } = {
    url: "http://127.0.0.1:9300",
    out: null,
    only: null,
    publish: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") opts.url = argv[++i].replace(/\/$/, "");
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--only") opts.only = argv[++i];
    else if (a === "--publish") opts.publish = true;
    else if (a === "-h" || a === "--help") {
      console.log(`Usage: node bin/shots.ts [--url <base>] [--out <dir>] [--only <substr>] [--publish]

Captures every Voir view into screenshots + a contact sheet.
Requires a running stack (npm run dev:mock). --only filters shots
by name substring (e.g. --only chat).

--publish writes the gallery to site/ (committed, WebP, stable file
names) for the GitHub Pages site instead of a timestamped dir under
shots/. That is what "npm run shots:publish" does.`);
      process.exit(0);
    } else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

const folderUrl = (path: string) => `/f/${encodeURI(path).replace(/^\//, "")}`;

// ── helpers ──────────────────────────────────────────────────────────
const stamp = new Date()
  .toISOString()
  .replace(/[:.]/g, "-")
  .replace("T", "_")
  .slice(0, 19);
// Two output layouts from one walker:
//
//   local    shots/<stamp>/index.html + shots/<stamp>/<file>.png
//   publish  site/index.html          + site/shots/<file>.webp
//
// The published layout is what GitHub Pages serves (`site/` is the
// artifact), so it uses stable paths across runs — the site is
// committed, and the page always shows the newest capture. WebP because
// these are UI screenshots living in git: same fidelity for a fraction
// of the bytes.
const IMG_EXT = opts.publish ? "webp" : "png";
const IMG_DIR = opts.publish
  ? resolve(ROOT, "site", "shots")
  : resolve(opts.out ?? join(ROOT, "shots", stamp));
const INDEX_DIR = opts.publish ? resolve(ROOT, "site") : IMG_DIR;
const IMG_PREFIX = opts.publish ? "shots/" : "";
if (opts.publish) {
  // Replace the previous images wholesale so a removed view can't
  // linger and the committed tree can't accumulate strays.
  rmSync(IMG_DIR, { recursive: true, force: true });
}
mkdirSync(IMG_DIR, { recursive: true });
mkdirSync(INDEX_DIR, { recursive: true });

type Shot = { file: string; label: string; viewport: string; group: string };
const shots: Shot[] = [];

// Dev-mode SSR is interactive before React hydrates; every click
// after a navigation needs the hydration pause (same rule the e2e
// suite follows).
async function settle(page: Page, ms = 350) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(ms);
}

async function shot(
  page: Page,
  viewport: string,
  group: string,
  name: string,
  label: string,
  fullPage = true,
) {
  if (opts.only && !name.includes(opts.only) && !group.includes(opts.only)) return;
  const file = `${viewport}-${name}.${IMG_EXT}`;
  await page.screenshot({
    path: join(IMG_DIR, file),
    fullPage,
    scale: "css",
    ...(IMG_EXT === "webp" ? { type: "webp" as const, quality: 90 } : {}),
  });
  shots.push({ file, label, viewport, group });
  console.log(`  ✓ ${viewport}/${name} — ${label}`);
}

// Scroll whatever overflow container dominates the page (the chat
// transcript) to top or bottom, so long pages get two frames.
async function scrollTranscript(page: Page, where: "top" | "bottom") {
  await page.evaluate((w) => {
    const els = Array.from(document.querySelectorAll("div")).filter((d) => {
      const cs = getComputedStyle(d);
      return (
        (cs.overflowY === "auto" || cs.overflowY === "scroll") &&
        d.scrollHeight > d.clientHeight + 100
      );
    });
    els.sort(
      (a, b) =>
        b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight),
    );
    const el = els[0];
    if (el) el.scrollTop = w === "top" ? 0 : el.scrollHeight;
  }, where);
  await page.waitForTimeout(250);
}

/** Session links on a folder page: [{ title, href }]. */
async function sessionLinks(page: Page) {
  return await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href*="/s/"]')).map((a) => ({
      title: (a.textContent ?? "").replace(/\s+/g, " ").trim(),
      href: a.getAttribute("href") ?? "",
    })),
  );
}

function pick(
  list: { title: string; href: string }[],
  ...needles: string[]
): { title: string; href: string } | undefined {
  for (const n of needles) {
    const hit = list.find((s) => s.title.toLowerCase().includes(n.toLowerCase()));
    if (hit) return hit;
  }
  return list[0];
}

// ── main ─────────────────────────────────────────────────────────────
// The five review targets come from test/displays.ts — one source of
// truth shared with the e2e projects, so a gallery run and a test run
// always look at the same panels.

console.log(
  `[shots] target ${opts.url}\n[shots] images ${IMG_DIR}\n[shots] page   ${join(INDEX_DIR, "index.html")}\n`,
);

// Discover the mock folders from the app itself — the paths are
// absolute and depend on where the checkout lives.
const foldersRes = await fetch(`${opts.url}/api/folders`);
const { folders } = (await foldersRes.json()) as {
  folders: { path: string }[];
};
const folderA = folders.find((f) => f.path.endsWith("project-a"))?.path;
const folderB = folders.find((f) => f.path.endsWith("project-b"))?.path;
if (!folderA) {
  console.error(
    "[shots] no project-a folder registered — is the mock stack up? (npm run dev:mock)",
  );
  process.exit(1);
}

const browser: Browser = await chromium.launch();

for (const d of DISPLAYS) {
  console.log(`[shots] ── ${d.id}  ${displaySummary(d)}`);
  const ctx = await browser.newContext({
    viewport: { width: d.width, height: d.height },
    deviceScaleFactor: d.dpr,
    hasTouch: d.touch,
    isMobile: d.touch,
  });
  const page = await ctx.newPage();

  // 1) Home: shortlist + folder tree.
  await page.goto(`${opts.url}/`);
  await settle(page);
  await shot(page, d.id, "home", "home", "Home — Working on + folders");

  // 2) Folder A sessions list.
  await page.goto(`${opts.url}${folderUrl(folderA)}`);
  await settle(page);
  await shot(page, d.id, "folder", "folder-a", "Folder A — session list");
  const sessionsA = await sessionLinks(page);

  // 3) Chat: seeded transcript, bottom (auto-scrolled) and top.
  const mainSession = pick(sessionsA, "voir", "health", "triage");
  if (mainSession) {
    await page.goto(`${opts.url}${mainSession.href}`);
    await settle(page, 900);
    await shot(
      page,
      d.id,
      "chat",
      "chat-bottom",
      `Chat — ${mainSession.title} (bottom)`,
      false,
    );
    await scrollTranscript(page, "top");
    await shot(
      page,
      d.id,
      "chat",
      "chat-top",
      `Chat — ${mainSession.title} (top)`,
      false,
    );

    // 3b) Chrome collapsed: the conversation-only view, with the
    // restore handle pinned to the top-right corner.
    await page.getByLabel("Hide top bar").click();
    await page.waitForTimeout(350);
    await shot(page, d.id, "chrome", "bar-hidden", "Chat — top bar hidden", false);
    await page.getByLabel("Show top bar").click();
    await page.waitForTimeout(250);

    // 4) Model sheet open (grip strip → bottom sheet).
    await page
      .getByRole("button", { name: "Open model, mode and fence" })
      .click();
    await page.waitForTimeout(400);
    await shot(page, d.id, "chat", "drawer", "Chat — model sheet open", false);
    // Close it again: the sheet is a modal overlay, so the next steps (menu,
    // tabs) would be blocked behind it.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);

    // 5) Global menu (folder/session switcher).
    await page.getByRole("button", { name: /^(Menu|Close menu)$/ }).click();
    await page.waitForTimeout(350);
    await shot(page, d.id, "nav", "picker", "Global menu open", false);
  }

  // 6) Rich content tour: modules at the top, sandbox tail below.
  const richSession = pick(sessionsA, "rich");
  if (richSession && richSession.title.toLowerCase().includes("rich")) {
    await page.goto(`${opts.url}${richSession.href}`);
    await settle(page, 1400); // module frames + CDN-backed d3
    await page
      .locator('[data-testid="mermaid-svg"] svg')
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => {});
    await scrollTranscript(page, "top");
    await shot(
      page,
      d.id,
      "rich",
      "rich-top",
      "Rich content — mermaid/chart/table/card",
      false,
    );
    await scrollTranscript(page, "bottom");
    await shot(
      page,
      d.id,
      "rich",
      "rich-bottom",
      "Rich content — d3 + sandboxed html",
      false,
    );
  }

  // 7) Tabs: Files and Changes.
  if (mainSession) {
    await page.goto(`${opts.url}${mainSession.href}?view=files`);
    await settle(page, 600);
    await shot(page, d.id, "tabs", "files", "Files tab", false);
    await page.goto(`${opts.url}${mainSession.href}?view=changes`);
    await settle(page, 900);
    await shot(page, d.id, "tabs", "changes", "Changes tab (diff)", false);
  }

  // 8) Folder B: the distinct seed set + one of its transcripts.
  if (folderB) {
    await page.goto(`${opts.url}${folderUrl(folderB)}`);
    await settle(page);
    await shot(page, d.id, "folder", "folder-b", "Folder B — session list");
    const sessionsB = await sessionLinks(page);
    const bSession = pick(sessionsB, "parse", "audit", "sandbox");
    if (bSession) {
      await page.goto(`${opts.url}${bSession.href}`);
      await settle(page, 900);
      await shot(
        page,
        d.id,
        "chat",
        "chat-b",
        `Chat (folder B) — ${bSession.title}`,
        false,
      );
    }
  }

  await ctx.close();
}

await browser.close();

// Provenance for the published page: which commit these shots show.
function gitHead(): { sha: string; subject: string } {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const subject = execFileSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { sha, subject };
  } catch {
    return { sha: "unknown", subject: "" };
  }
}
const head = gitHead();

// ── contact sheet + lightbox (shared: tools/gallery/gallery.ts) ──────
// The page itself is app-agnostic — see the module header for how
// another app reuses it.
writeGallery({
  outDir: INDEX_DIR,
  imgDir: IMG_DIR,
  imgPrefix: IMG_PREFIX,
  title: "Voir — visual review",
  stamp,
  commit: head,
  devices: DISPLAYS.map((d) => ({
    id: d.id,
    label: d.label,
    note: displaySummary(d),
  })),
  shots: shots.map((s) => ({
    file: s.file,
    label: s.label,
    group: s.group,
    device: s.viewport,
  })),
});

console.log(
  `\n[shots] ${shots.length} screenshots → ${IMG_DIR}\n[shots] open ${join(INDEX_DIR, "index.html")}\n` +
    (opts.publish
      ? "[shots] published into site/ — commit it and Pages serves it\n"
      : "[shots] or serve it: npm run shots:serve\n"),
);
