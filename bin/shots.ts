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

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import { DISPLAYS, displaySummary } from "../test/displays";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── args ────────────────────────────────────────────────────────────
function parseArgs(argv: string[]) {
  const opts: { url: string; out: string | null; only: string | null } = {
    url: "http://127.0.0.1:9300",
    out: null,
    only: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") opts.url = argv[++i].replace(/\/$/, "");
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--only") opts.only = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log(`Usage: node bin/shots.mjs [--url <base>] [--out <dir>] [--only <substr>]

Captures every Voir view into screenshots + a contact sheet.
Requires a running stack (npm run dev:mock). --only filters shots
by name substring (e.g. --only chat).`);
      process.exit(0);
    } else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// Mirrors app/lib/format.ts shortPath().
function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 2 ? p : "…/" + parts.slice(-2).join("/");
}
const folderUrl = (path: string) => `/f/${encodeURI(path).replace(/^\//, "")}`;

// ── helpers ──────────────────────────────────────────────────────────
const stamp = new Date()
  .toISOString()
  .replace(/[:.]/g, "-")
  .replace("T", "_")
  .slice(0, 19);
const OUT = resolve(opts.out ?? join(ROOT, "shots", stamp));
mkdirSync(OUT, { recursive: true });

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
  const file = `${viewport}-${name}.png`;
  await page.screenshot({ path: join(OUT, file), fullPage, scale: "css" });
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
// The three review targets come from test/displays.ts — one source of
// truth shared with the e2e projects, so a gallery run and a test run
// always look at the same panels.

console.log(`[shots] target ${opts.url}\n[shots] output ${OUT}\n`);

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

    // 4) Drawer open on this chat.
    await page
      .getByRole("button", { name: "Open model, mode and fence" })
      .click();
    await page.waitForTimeout(350);
    await shot(page, d.id, "chat", "drawer", "Chat — model drawer open", false);

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

// ── contact sheet ────────────────────────────────────────────────────
const byViewport = new Map<string, Shot[]>();
for (const s of shots) {
  const list = byViewport.get(s.viewport) ?? [];
  list.push(s);
  byViewport.set(s.viewport, list);
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Section headings carry the panel, not just its key — the gallery is
// the review artifact, so it should say "Fold 8 — inner · 816 × 609 CSS
// · 7.6″ 4:3 main pane (landscape)" without a lookup elsewhere.
const displayTitle = (id: string) => {
  const d = DISPLAYS.find((x) => x.id === id);
  return d ? `${d.label} — ${displaySummary(d)}` : id;
};

const sections = Array.from(byViewport.entries())
  .map(
    ([vp, list]) => `
  <section>
    <h2>${esc(displayTitle(vp))}</h2>
    <div class="grid">
${list
  .map(
    (s) => `      <figure class="${esc(s.group)}">
        <a href="${esc(s.file)}" target="_blank"><img src="${esc(s.file)}" loading="lazy" alt="${esc(s.label)}"></a>
        <figcaption><b>${esc(s.label)}</b><code>${esc(s.file)}</code></figcaption>
      </figure>`,
  )
  .join("\n")}
    </div>
  </section>`,
  )
  .join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Voir — visual review ${esc(stamp)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0a0a0b; color: #e5e5e5;
    font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
  header { padding: 16px 20px; border-bottom: 1px solid #262626;
    display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  header code { color: #737373; font-size: 12px; }
  header .count { margin-left: auto; color: #a3a3a3; font-size: 12px;
    font-family: ui-monospace, monospace; }
  section { padding: 20px; }
  h2 { font-size: 11px; letter-spacing: .12em; text-transform: uppercase;
    color: #737373; margin: 0 0 14px; font-weight: 500; }
  .grid { display: grid; gap: 22px;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    align-items: start; }
  figure { margin: 0; }
  figure img { display: block; width: 100%; height: auto; border: 1px solid #262626;
    border-radius: 6px; background: #111; }
  figcaption { margin-top: 6px; font-size: 12px; color: #a3a3a3; }
  figcaption b { display: block; color: #e5e5e5; font-weight: 500; }
  figcaption code { color: #525252; font-family: ui-monospace, monospace;
    font-size: 11px; }
  .chat figure img, .rich figure img, .tabs figure img { max-height: 620px;
    object-fit: cover; object-position: top; }
  a { color: inherit; }
</style>
</head>
<body>
<header>
  <h1>Voir — visual review</h1>
  <code>${esc(stamp)}</code>
  <span class="count">${shots.length} shots · ${byViewport.size} displays</span>
</header>
${sections}
</body>
</html>
`;

writeFileSync(join(OUT, "index.html"), html);
writeFileSync(
  join(OUT, "manifest.json"),
  JSON.stringify({ stamp, target: opts.url, shots }, null, 2) + "\n",
);

console.log(
  `\n[shots] ${shots.length} screenshots → ${OUT}\n[shots] open ${join(OUT, "index.html")}\n[shots] or serve it: npm run shots:serve\n`,
);
