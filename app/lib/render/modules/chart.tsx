/**
 * voir-chart (docs/rich-content.md, module 5): the agent-agnostic
 * graph — the agent queried ANY data source (grafana MCP, files,
 * its own tools) and emits one JSON block; voir draws it client-
 * side with uPlot. Types: line | area | bar (bar → line in v1).
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import UPlot from "uplot";
import { parseChart, toUPlotData, type ChartData } from "../parse";

// uPlot ships a CSS file; vite bundles it with the lazy chunk.
import "uplot/dist/uPlot.min.css";
import type { RenderProps } from "../registry";

const PALETTE = ["#fbbf24", "#60a5fa", "#34d399", "#f472b6", "#a78bfa", "#f87171"];

export default function Chart({ data, context, fallback }: RenderProps<ChartData> & { fallback?: ReactNode }) {
  const body = context.carrier.kind === "fenced" ? context.carrier.body : "";
  const chart = parseChart(body);
  if (!chart) return <>{fallback ?? null}</>;
  return <ChartView chart={chart} />;
}

function ChartView({ chart }: { chart: ChartData }) {
  const wrap = useRef<HTMLDivElement>(null);
  const plot = useRef<UPlot | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 0));
    ro.observe(el);
    setWidth(el.clientWidth || 0);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const mount = wrap.current;
    if (width < 40 || !mount) return;
    let disposed = false;
    void (async () => {
      if (disposed) return;
      const { xs, ys } = toUPlotData(chart);
      if (xs.length < 2) return;
      const opts: UPlot.Options = {
        width,
        height: 240, // no inner scroll — the page scrolls
        title: undefined, // voir renders the title itself
        legend: { show: true, live: false },
        cursor: { points: { show: false } },
        scales: { x: { time: true } },
        axes: [
          {
            stroke: "#737373",
            grid: { stroke: "#262626", width: 1 },
            ticks: { stroke: "#404040" },
            values: [
              // dense tick skipping for narrow phones
              [3600, "{h}:{mm}"],
              [1, "{H}:{mm}"],
            ],
          },
          {
            stroke: "#737373",
            grid: { stroke: "#262626", width: 1 },
            ticks: { stroke: "#404040" },
            label: chart.unit,
            labelSize: 16,
          },
        ],
        series: [
          {},
          ...chart.series.map((s, i) => ({
            label: s.label,
            stroke: PALETTE[i % PALETTE.length],
            width: 1.5,
            fill: chart.type === "area" ? PALETTE[i % PALETTE.length] + "22" : undefined,
            points: { show: xs.length < 30 },
          })),
        ],
      };
      void UPlot; // class import; instantiate below
      if (plot.current) {
        plot.current.destroy();
        plot.current = null;
      }
      plot.current = new UPlot(opts, [xs, ...ys], mount);
    })();
    return () => {
      disposed = true;
      if (plot.current) {
        plot.current.destroy();
        plot.current = null;
      }
    };
  }, [chart, width]);

  return (
    <div className="border border-neutral-800 bg-neutral-900">
      <div className="flex items-baseline gap-2 border-b border-neutral-800 px-3 py-1.5">
        <span className="text-[12px] font-medium text-neutral-200">{chart.title ?? "Chart"}</span>
        {chart.unit && <span className="font-mono text-[10px] uppercase tracking-widest text-neutral-500">{chart.unit}</span>}
        {chart.type === "bar" && (
          <span className="font-mono text-[10px] text-neutral-600" title="bars render as lines in v1">
            (bar→line)
          </span>
        )}
      </div>
      <div ref={wrap} className="px-1 py-2" data-testid="chart-plot" />
    </div>
  );
}