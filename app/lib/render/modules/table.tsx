/**
 * table (docs/rich-content.md, module 4): ```csv / ```tsv blocks →
 * rendered table — sticky header, horizontal scroll, numeric
 * columns get a sparkline row under the table (hand-rolled SVG,
 * no dependency; Spark lives in card.tsx, its only import).
 */
import { useMemo } from "react";
import type { ReactNode } from "react";
import { parseTable } from "../parse";
import type { RenderProps } from "../registry";
import { Spark } from "./card";

export default function Table({ data, context, fallback }: RenderProps<string> & { fallback?: ReactNode }) {
  const lang = context.carrier.kind === "fenced" ? context.carrier.lang : "csv";
  const t = useMemo(() => parseTable(data, lang), [data, lang]);
  if (!t) return <>{fallback ?? null}</>;
  const sparkRows = t.numericCols.map((col) => ({
    label: t.header[col] ?? `col ${col + 1}`,
    values: t.rows
      .map((r) => (r[col] ? Number(r[col]) : null))
      .filter((v): v is number => v != null && Number.isFinite(v)),
  }));
  return (
    <div className="border border-neutral-800 bg-neutral-900" data-testid="rich-table">
      <div>
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              {t.header.map((h, i) => (
                <th
                  key={i}
                  className={
                    "sticky left-0 top-0 border-b border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-left font-mono text-[11px] uppercase tracking-wider text-neutral-500 " +
                    (t.numericCols.includes(i) ? "text-right" : "")
                  }
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((row, ri) => (
              <tr key={ri} className={ri % 2 ? "" : "bg-neutral-950/40"}>
                {t.header.map((_, ci) => (
                  <td
                    key={ci}
                    className={
                      "px-2.5 py-1.5 align-top font-mono text-[12px] text-neutral-300 [overflow-wrap:anywhere] " +
                      (t.numericCols.includes(ci) ? "text-right" : "")
                    }
                  >
                    {row[ci] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sparkRows.length > 0 && (
        <div className="flex flex-wrap items-end gap-x-4 gap-y-1 border-t border-neutral-800 px-2.5 py-1.5">
          {sparkRows.map((s) => (
            <span key={s.label} className="flex items-center gap-1.5">
              <span className="font-mono text-[10px] text-neutral-600">{s.label}</span>
              {s.values.length >= 2 && <Spark values={s.values} width={64} height={20} />}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}