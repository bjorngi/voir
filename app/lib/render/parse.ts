/**
 * Pure parsers/validators for the rich-content modules
 * (docs/rich-content.md). No React imports — shared between the
 * client modules and the test suite.
 *
 * The registry's sniffs call the card/chart validators (cheap
 * "is this ours?" checks); the module components run the same
 * validator again as their schema — detection is loose, schema
 * is the same function, so a module can never render a payload
 * its validator rejected.
 */

// ── card (```voir-card) ─────────────────────────────────────────────

export type PillTone = "good" | "warn" | "bad" | "info";

export interface CardAction {
  label: string;
  kind: "send" | "prefill" | "link";
  value: string;
}

export interface CardRow {
  k: string;
  v: string;
  delta?: string;
  /** [ts, value] pairs (or bare values) — rendered as a sparkline. */
  spark?: Array<[number, number] | number>;
}

export interface CardData {
  title?: string;
  pill?: { text: string; tone?: PillTone };
  rows?: CardRow[];
  actions?: CardAction[];
}

const TONES: ReadonlySet<string> = new Set(["good", "warn", "bad", "info"]);

/**
 * Validate a ```voir-card payload. Returns null on anything that
 * isn't a card — the registry then renders plain code (honest
 * degradation for malformed agent output).
 */
export function parseCard(body: string): CardData | null {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const hasTitle = typeof o.title === "string";
  const hasRows = Array.isArray(o.rows) && o.rows.length > 0;
  const hasActions = Array.isArray(o.actions) && o.actions.length > 0;
  const hasPill = o.pill != null && typeof o.pill === "object";
  if (!hasTitle && !hasRows && !hasActions && !hasPill) return null;

  const pillRaw = o.pill as { text?: unknown; tone?: unknown } | undefined;
  const pill =
    pillRaw && typeof pillRaw.text === "string"
      ? {
          text: pillRaw.text,
          tone: typeof pillRaw.tone === "string" && TONES.has(pillRaw.tone)
            ? (pillRaw.tone as PillTone)
            : undefined,
        }
      : undefined;

  const rows: CardRow[] = [];
  if (hasRows) {
    for (const r of o.rows as unknown[]) {
      if (!r || typeof r !== "object") continue;
      const rr = r as Record<string, unknown>;
      if (typeof rr.k !== "string" || typeof rr.v !== "string") continue;
      rows.push({
        k: rr.k,
        v: rr.v,
        delta: typeof rr.delta === "string" ? rr.delta : undefined,
        spark: isSpark(rr.spark) ? rr.spark : undefined,
      });
    }
  }

  const actions: CardAction[] = [];
  if (hasActions) {
    for (const a of o.actions as unknown[]) {
      if (!a || typeof a !== "object") continue;
      const aa = a as Record<string, unknown>;
      if (
        typeof aa.label !== "string" ||
        typeof aa.value !== "string" ||
        (aa.kind !== "send" && aa.kind !== "prefill" && aa.kind !== "link")
      ) {
        continue;
      }
      actions.push({ label: aa.label, kind: aa.kind, value: aa.value });
    }
  }

  return {
    title: hasTitle ? (o.title as string) : undefined,
    pill,
    rows: rows.length > 0 ? rows : undefined,
    actions: actions.length > 0 ? actions : undefined,
  };
}

function isSpark(v: unknown): v is Array<[number, number] | number> {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    v.every(
      (p) =>
        typeof p === "number" ||
        (Array.isArray(p) &&
          p.length === 2 &&
          typeof p[0] === "number" &&
          typeof p[1] === "number"),
    )
  );
}

// ── chart (```voir-chart) ───────────────────────────────────────────

export interface ChartSeries {
  label: string;
  points: Array<[number, number]>;
}

export interface ChartData {
  title?: string;
  unit?: string;
  /** line | area | bar (bar renders as line in v1). */
  type: "line" | "area" | "bar";
  series: ChartSeries[];
}

/** Validate a ```voir-chart payload; null = not ours. */
export function parseChart(body: string): ChartData | null {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.series) || o.series.length === 0) return null;

  const series: ChartSeries[] = [];
  for (const s of o.series as unknown[]) {
    if (!s || typeof s !== "object") continue;
    const ss = s as Record<string, unknown>;
    if (typeof ss.label !== "string" || !Array.isArray(ss.points)) continue;
    const points: Array<[number, number]> = [];
    for (const p of ss.points) {
      if (Array.isArray(p) && p.length === 2 && typeof p[0] === "number" && typeof p[1] === "number") {
        points.push([p[0], p[1]]);
      }
    }
    if (points.length >= 2) series.push({ label: ss.label, points });
  }
  if (series.length === 0) return null;

  const type =
    o.type === "area" || o.type === "bar" ? (o.type as ChartData["type"]) : "line";
  return {
    title: typeof o.title === "string" ? o.title : undefined,
    unit: typeof o.unit === "string" ? o.unit : undefined,
    type,
    series,
  };
}

/**
 * Convert chart data into uPlot's aligned-array form: a sorted
 * union of all x values, one (gap-tolerant, null-padded) array
 * per series.
 */
export function toUPlotData(chart: ChartData): {
  xs: number[];
  ys: Array<Array<number | null>>;
} {
  const xs = [...new Set(chart.series.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b);
  const ys = chart.series.map((s) => {
    const byX = new Map(s.points.map((p) => [p[0], p[1]]));
    // uPlot wants dense arrays with nulls for gaps
    return xs.map((x) => byX.get(x) ?? null);
  });
  return { xs, ys };
}

// ── csv/tsv (```table module) ───────────────────────────────────────

export interface ParsedTable {
  header: string[];
  rows: string[][];
  /** Column indexes where most values parse as numbers (for sparklines). */
  numericCols: number[];
}

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

/** Minimal CSV with quotes; TSV is a plain split. */
export function parseTable(body: string, lang: string): ParsedTable | null {
  const delim = lang === "tsv" ? "\t" : ",";
  const rows =
    delim === "\t"
      ? body.split("\n").map((l) => l.split("\t"))
      : parseCsv(body);
  const nonEmpty = rows.filter((r) => r.length > 0 && r.some((c) => c.trim() !== ""));
  if (nonEmpty.length < 2 || nonEmpty[0].length < 2) return null;
  const header = nonEmpty[0].map((c) => c.trim());
  const dataRows = nonEmpty.slice(1).map((r) => r.map((c) => c.trim()));
  const numericCols: number[] = [];
  for (let i = 0; i < header.length; i++) {
    const vals = dataRows.map((r) => r[i] ?? "");
    const numeric = vals.filter((v) => v !== "" && NUMERIC_RE.test(v)).length;
    if (numeric >= Math.max(1, Math.ceil(vals.length * 0.6))) numericCols.push(i);
  }
  return { header, rows: dataRows, numericCols };
}

/** RFC-4180-lite: quoted fields, doubled quotes, embedded commas/newlines. */
function parseCsv(body: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inQuotes) {
      if (c === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (c !== "\r") {
      field += c;
    }
  }
  row.push(field);
  rows.push(row);
  return rows;
}

// ── sparkline geometry (shared by card rows + table columns) ────────

/**
 * Points for an inline SVG polyline normalised to a width×height
 * box with 1px padding. Nulls are skipped (gaps).
 */
export function sparkPoints(
  values: Array<[number, number] | number>,
  width: number,
  height: number,
): Array<[number, number]> {
  const nums = values
    .map((v) => (Array.isArray(v) ? v[1] : v))
    .filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length < 2) return [];
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  // Flat series center on the box (the min-max path would pin
  // every point to the bottom edge).
  if (max === min) {
    const y = Math.round(height / 2);
    return nums.map((_, i) => [
      Math.round(1 + (i / (nums.length - 1)) * (width - 2)),
      y,
    ]);
  }
  const span = max - min;
  return nums.map((v, i) => [
    Math.round(1 + (i / (nums.length - 1)) * (width - 2)),
    Math.round(height - 1 - ((v - min) / span) * (height - 2)),
  ]);
}
