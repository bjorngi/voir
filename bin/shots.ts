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

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium, type Browser, type Page } from "@playwright/test";
import { DISPLAYS, displaySummary } from "../test/displays";

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
// Provenance for the published page: which commit these shots show.
// Falls back to "unknown" outside a checkout (CI tarballs, etc.).
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
  <section data-title="${esc(displayTitle(vp))}">
    <h2>${esc(displayTitle(vp))}</h2>
    <div class="grid">
${list
  .map(
    (s) => `      <figure class="${esc(s.group)} shot" data-src="${esc(IMG_PREFIX + s.file)}" data-label="${esc(s.label)}">
        <button type="button" class="thumb" aria-label="Open ${esc(s.label)} full size">
          <img src="${esc(IMG_PREFIX + s.file)}" loading="lazy" alt="${esc(s.label)}">
        </button>
        <figcaption>
          <b>${esc(s.label)}</b>
          <code>${esc(s.file)}</code>
          <a href="${esc(IMG_PREFIX + s.file)}" target="_blank" rel="noreferrer">open raw ↗</a>
        </figcaption>
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
  header .hint { color: #525252; font-family: ui-monospace, monospace;
    font-size: 11px; }
  .thumb { display: block; width: 100%; padding: 0; border: 0; background: none;
    cursor: zoom-in; }
  .thumb:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
  figcaption a { color: #525252; text-decoration: none; margin-left: 6px; }
  figcaption a:hover { color: #a3a3a3; }

  /* Lightbox: fixed overlay, image contained to the viewport. */
  #lb[hidden] { display: none; }
  #lb { position: fixed; inset: 0; z-index: 50; display: flex;
    flex-direction: column; background: #050505f2; backdrop-filter: blur(2px); }
  #lb-bar { display: flex; align-items: center; gap: 12px; padding: 10px 14px;
    border-bottom: 1px solid #262626; font-size: 12px; color: #a3a3a3; }
  #lb-bar .grow { flex: 1; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  #lb-bar b { color: #e5e5e5; font-weight: 500; }
  #lb-count { font-family: ui-monospace, monospace; color: #737373; }
  #lb-bar button { height: 32px; min-width: 44px; border: 1px solid #333;
    background: #111; color: #e5e5e5; border-radius: 4px; cursor: pointer;
    font-size: 15px; line-height: 1; }
  #lb-bar button:hover { background: #1c1c1c; }
  #lb-stage { flex: 1; min-height: 0; display: grid; place-items: center;
    padding: 10px; cursor: zoom-out; }
  #lb-img { max-width: 100%; max-height: 100%; object-fit: contain;
    box-shadow: 0 10px 40px #000a; background: #0a0a0b; }
  @media (max-width: 720px) { #lb-bar .kbd { display: none; } }
</style>
</head>
<body>
<header>
  <h1>Voir — visual review</h1>
  <code>${esc(stamp)}</code>
  <code title="${esc(head.subject)}">@ ${esc(head.sha)}</code>
  <span class="count">${shots.length} shots · ${byViewport.size} displays</span>
  <span class="hint">click a shot to browse · ← → · Esc</span>
</header>
${sections}

<div id="lb" hidden role="dialog" aria-modal="true" aria-label="Screenshot viewer">
  <div id="lb-bar">
    <button type="button" id="lb-prev" aria-label="Previous shot">‹</button>
    <button type="button" id="lb-next" aria-label="Next shot">›</button>
    <span class="grow"><b id="lb-cap"></b></span>
    <span id="lb-count"></span>
    <span class="kbd" style="color:#525252">← → to browse · Esc to close</span>
    <button type="button" id="lb-close" aria-label="Close">✕</button>
  </div>
  <div id="lb-stage"><img id="lb-img" alt=""></div>
</div>
<script>
// Lightbox: click a shot to open, ←/→ (and swipe) to walk the whole
// review, Esc to close. Order follows the page: every view of display 1,
// then display 2, then 3 — so a redesign can be reviewed as one sequence.
(() => {
  const shots = Array.from(document.querySelectorAll("figure.shot"));
  const lb = document.getElementById("lb");
  const img = document.getElementById("lb-img");
  const cap = document.getElementById("lb-cap");
  const count = document.getElementById("lb-count");
  let i = 0;

  function show(n) {
    i = (n + shots.length) % shots.length;
    const fig = shots[i];
    img.src = fig.dataset.src;
    img.alt = fig.dataset.label || "";
    cap.textContent = fig.dataset.label || fig.dataset.src;
    const section = fig.closest("section");
    count.textContent =
      (i + 1) + " / " + shots.length +
      (section ? " · " + (section.dataset.title || "") : "");
    lb.hidden = false;
    document.body.style.overflow = "hidden";
    // Warm the neighbours so arrow-key browsing feels instant.
    for (const d of [-1, 1]) {
      const n2 = (i + d + shots.length) % shots.length;
      const pre = new Image();
      pre.src = shots[n2].dataset.src;
    }
  }
  function close() {
    lb.hidden = true;
    document.body.style.overflow = "";
    img.removeAttribute("src");
  }

  shots.forEach((fig, n) => {
    const b = fig.querySelector("button.thumb");
    if (b) b.addEventListener("click", () => show(n));
  });
  document.getElementById("lb-prev").onclick = () => show(i - 1);
  document.getElementById("lb-next").onclick = () => show(i + 1);
  document.getElementById("lb-close").onclick = close;
  document.getElementById("lb-stage").onclick = close;
  lb.addEventListener("click", (e) => { if (e.target === lb) close(); });

  addEventListener("keydown", (e) => {
    if (lb.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); show(i - 1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); show(i + 1); }
    else if (e.key === "Home") { e.preventDefault(); show(0); }
    else if (e.key === "End") { e.preventDefault(); show(shots.length - 1); }
  });

  // Touch: horizontal swipe moves through the sequence.
  let x0 = null;
  lb.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; },
    { passive: true });
  lb.addEventListener("touchend", (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 45) show(i + (dx < 0 ? 1 : -1));
    x0 = null;
  }, { passive: true });
})();
</script>
</body>
</html>
`;

writeFileSync(join(INDEX_DIR, "index.html"), html);
writeFileSync(
  join(INDEX_DIR, "manifest.json"),
  JSON.stringify({ stamp, target: opts.url, shots }, null, 2) + "\n",
);

console.log(
  `\n[shots] ${shots.length} screenshots → ${IMG_DIR}\n[shots] open ${join(INDEX_DIR, "index.html")}\n` +
    (opts.publish
      ? "[shots] published into site/ — commit it and Pages serves it\n"
      : "[shots] or serve it: npm run shots:serve\n"),
);
