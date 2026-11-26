/**
 * The displays Voir is designed against.
 *
 * Five panels, five shapes — the spread is the point. A layout that
 * survives the tall cover pane has to be re-checked when the same app
 * unfolds into a 4:3 slab (both ways up), and again on a 16-inch
 * laptop. Every review artifact (e2e projects, screenshot galleries)
 * reads from this list so the targets stay in lockstep.
 *
 * Sizes are CSS pixels — what layout actually sees. `panel` is the
 * physical resolution, kept for the gallery labels and for anyone
 * sanity-checking the CSS/DPR arithmetic. deviceScaleFactor makes the
 * screenshots comparable in detail (and lets the emulated browser
 * rasterise at panel density, so a "device scale" shot is the real
 * panel pixel count).
 *
 *   Fold 8 cover   1248×1972 physical ÷ 3  = 416 × 657.3   (10:16)
 *   Fold 8 inner   2448×1828 physical ÷ 3  = 816 × 609.3   (4:3)
 *   MBP 16"        3456×2234 physical ÷ 2  = 1728 × 1117   (default
 *                                            "looks like" scaling)
 *
 * Rotated targets swap width/height and keep the panel pixel count, as
 * the device does. The fractional CSS pixels round down; a CSS pixel
 * either side is below the threshold where a breakpoint or a tap
 * target changes, so the emulation stays faithful.
 */

export type Display = {
  /** Stable key: Playwright project name + screenshot file prefix. */
  id: string;
  /** Human label for galleries and test output. */
  label: string;
  /** CSS pixels — the viewport layout is computed against. */
  width: number;
  height: number;
  /** Panel pixels per CSS pixel. */
  dpr: number;
  /** Physical panel resolution, [width, height]. */
  panel: readonly [number, number];
  /** Panel description (diagonal, aspect, orientation). */
  note: string;
  /** Touch emulation — the fold panes are phones. */
  touch: boolean;
};

export const DISPLAYS: readonly Display[] = [
  {
    id: "fold-cover-portrait",
    label: "Fold 8 — cover (portrait)",
    width: 416,
    height: 657,
    dpr: 3,
    panel: [1248, 1972],
    note: '5.5″ 10:16',
    touch: true,
  },
  {
    id: "fold-cover-landscape",
    label: "Fold 8 — cover (landscape)",
    width: 657,
    height: 416,
    dpr: 3,
    panel: [1972, 1248],
    note: '5.5″ 16:10 held sideways',
    touch: true,
  },
  {
    id: "fold-inner-portrait",
    label: "Fold 8 — inner (portrait)",
    width: 609,
    height: 816,
    dpr: 3,
    panel: [1828, 2448],
    note: '7.6″ 3:4 upright',
    touch: true,
  },
  {
    id: "fold-inner-landscape",
    label: "Fold 8 — inner (landscape)",
    width: 816,
    height: 609,
    dpr: 3,
    panel: [2448, 1828],
    note: '7.6″ 4:3 opened flat',
    touch: true,
  },
  {
    id: "laptop",
    label: 'Laptop — MacBook Pro 16"',
    width: 1728,
    height: 1117,
    dpr: 2,
    panel: [3456, 2234],
    note: '16.2″ 16:10, default scaled',
    touch: false,
  },
];

/** "416 × 657 CSS · 10:16" — the one-line description used in
 *  galleries and test output. */
export function displaySummary(d: Display): string {
  return `${d.width} × ${d.height} CSS · ${d.note}`;
}
