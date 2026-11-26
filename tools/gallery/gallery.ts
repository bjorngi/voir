/**
 * gallery — the reusable half of `npm run shots`.
 *
 * Takes a flat list of already-captured screenshots and produces the
 * review page: a contact sheet grouped by device, a keyboard-driven
 * lightbox (←/→/Home/End/Esc, swipe on touch), and a manifest. It knows
 * nothing about Voir: any app can collect its own pages and hand them
 * over, which is the point — torin, blockbook or a new tool should be
 * able to reuse the review surface without re-implementing it.
 *
 * Usage from an app's own capture script:
 *
 *   import { writeGallery } from "../tools/gallery/gallery";
 *
 *   const shots = [];
 *   for (const device of DEVICES) {
 *     const page = await context.newPage();
 *     await page.goto(url);
 *     await page.screenshot({ path: `${imgDir}/${device.id}-home.png` });
 *     shots.push({
 *       file: `${device.id}-home.png`,
 *       label: "Home",
 *       group: "home",          // CSS class: per-group thumbnail sizing
 *       device: device.id,      // section heading key
 *     });
 *   }
 *   writeGallery({
 *     outDir: "site",
 *     imgDir: "site/shots",
 *     imgPrefix: "shots/",
 *     title: "Torin — visual review",
 *     devices: DEVICES.map((d) => ({ id: d.id, label: d.label, note: d.note })),
 *     shots,
 *   });
 *
 * Conventions that keep galleries comparable across apps:
 *   - one file per (device, view), stable names, no timestamps — the
 *     published tree is committed and diffed;
 *   - WebP at quality 90 for published runs (UI screenshots: same
 *     fidelity, a fraction of the bytes), PNG for local iteration;
 *   - the page is a single self-contained HTML file — it must work
 *     from a plain static host (GitHub Pages) with no build step.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type GalleryShot = {
  /** File name inside imgDir (no directory part). */
  file: string;
  /** Caption shown in the sheet and in the lightbox. */
  label: string;
  /**
   * Group class for the figure. Galleries use it to size thumbnails:
   * list views can be shown tall, chat views cropped to the viewport.
   */
  group: string;
  /** Section this shot belongs to — a key of `devices`. */
  device: string;
};

export type GalleryDevice = {
  id: string;
  label: string;
  /** "416 × 657 CSS · 10:16" style note, shown in the section heading. */
  note: string;
};

export type GalleryOptions = {
  /** Where index.html + manifest.json go (the Pages artifact root). */
  outDir: string;
  /** Where the images are; only used to create the directory. */
  imgDir: string;
  /** Path prefix for src/href values, e.g. "shots/". */
  imgPrefix?: string;
  title: string;
  devices: readonly GalleryDevice[];
  shots: GalleryShot[];
  /** Provenance shown in the header: run stamp and commit subject/sha. */
  stamp: string;
  commit?: { sha: string; subject: string };
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function writeGallery(opts: GalleryOptions): void {
  const { devices, shots } = opts;
  const prefix = opts.imgPrefix ?? "";

  mkdirSync(opts.outDir, { recursive: true });
  mkdirSync(opts.imgDir, { recursive: true });

  const deviceOf = new Map(devices.map((d) => [d.id, d]));
  const byDevice = new Map<string, GalleryShot[]>();
  for (const s of shots) {
    const list = byDevice.get(s.device) ?? [];
    list.push(s);
    byDevice.set(s.device, list);
  }

  const sections = Array.from(byDevice.entries())
    .map(([id, list]) => {
      const d = deviceOf.get(id);
      const heading = d ? `${d.label} — ${d.note}` : id;
      return `
  <section data-title="${esc(heading)}">
    <h2>${esc(heading)}</h2>
    <div class="grid">
${list
  .map(
    (s) => `      <figure class="${esc(s.group)} shot" data-src="${esc(prefix + s.file)}" data-label="${esc(s.label)}">
        <button type="button" class="thumb" aria-label="Open ${esc(s.label)} full size">
          <img src="${esc(prefix + s.file)}" loading="lazy" alt="${esc(s.label)}">
        </button>
        <figcaption>
          <b>${esc(s.label)}</b>
          <code>${esc(s.file)}</code>
          <a href="${esc(prefix + s.file)}" target="_blank" rel="noreferrer">open raw ↗</a>
        </figcaption>
      </figure>`,
  )
  .join("\n")}
    </div>
  </section>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} ${esc(opts.stamp)}</title>
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
  header .hint { color: #525252; font-family: ui-monospace, monospace;
    font-size: 11px; }
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
  <h1>${esc(opts.title)}</h1>
  <code>${esc(opts.stamp)}</code>
  ${opts.commit ? `<code title="${esc(opts.commit.subject)}">@ ${esc(opts.commit.sha)}</code>` : ""}
  <span class="count">${shots.length} shots · ${byDevice.size} devices</span>
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
// review, Esc to close. Order follows the page: every view of device 1,
// then device 2, then 3 — so a redesign can be reviewed as one sequence.
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

  writeFileSync(join(opts.outDir, "index.html"), html);
  writeFileSync(
    join(opts.outDir, "manifest.json"),
    JSON.stringify(
      {
        stamp: opts.stamp,
        commit: opts.commit ?? null,
        devices,
        shots,
      },
      null,
      2,
    ) + "\n",
  );
}
