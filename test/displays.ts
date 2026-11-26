/**
 * The displays Voir is designed against.
 *
 * Three panels, three very different shapes — that spread is the
 * point. A mobile-first layout that survives the tall cover pane
 * (10:16) has to be re-checked when the same app unfolds into a
 * 4:3 landscape slab, and again on a laptop. Every review artifact
 * (e2e projects, screenshot galleries) reads from this list so the
 * three targets stay in lockstep.
 *
 * Sizes are CSS pixels — what layout actually sees. `panel` is the
 * physical resolution, kept for the gallery labels and for anyone
 * sanity-checking the CSS/DPR arithmetic. deviceScaleFactor makes
 * the screenshots comparable in detail (and lets the emulated
 * browser rasterise at panel density).
 *
 *   Fold 8 cover   1248×1972 physical ÷ 3        = 416 × 657.3  (10:16)
 *   Fold 8 inner   2448×1828 physical ÷ 3        = 816 × 609.3  (4:3)
 *   Laptop         2880×1800 physical ÷ 2        = 1440 × 900   (16:10)
 *
 * The fractional pixels round down; a CSS pixel either side is
 * below the threshold where a layout breakpoint or a tap target
 * changes, so the emulation stays faithful.
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
  /** Panel description (diagonal, aspect) for labels. */
  note: string;
  /** Touch emulation — the two fold panes are phones. */
  touch: boolean;
};

export const DISPLAYS: readonly Display[] = [
  {
    id: "fold-cover",
    label: "Fold 8 — cover",
    width: 416,
    height: 657,
    dpr: 3,
    panel: [1248, 1972],
    note: '5.5″ 10:16 cover pane',
    touch: true,
  },
  {
    id: "fold-inner",
    label: "Fold 8 — inner",
    width: 816,
    height: 609,
    dpr: 3,
    panel: [2448, 1828],
    note: '7.6″ 4:3 main pane (landscape)',
    touch: true,
  },
  {
    id: "laptop",
    label: "Laptop",
    width: 1440,
    height: 900,
    dpr: 2,
    panel: [2880, 1800],
    note: "16:10 laptop",
    touch: false,
  },
];

/** "416 × 657 CSS · 10:16" — the one-line description used in
 *  galleries and test output. */
export function displaySummary(d: Display): string {
  return `${d.width} × ${d.height} CSS · ${d.note}`;
}
