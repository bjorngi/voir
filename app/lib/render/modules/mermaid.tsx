/**
 * mermaid (docs/rich-content.md, module 1): ```mermaid blocks →
 * rendered diagram. Client-side mermaid (lazy import, dark theme,
 * `securityLevel: "strict"` so labels are escaped — diagram
 * syntax, no user script execution; the static tier). Parse
 * failures fall back to the block with the error shown — an
 * agent-agnostic honest degradation.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { RenderProps } from "../registry";

let mermaidInit: Promise<typeof import("mermaid")["default"]> | null = null;

/** One shared, initialized mermaid instance (HMR-safe). */
function getMermaid(): Promise<typeof import("mermaid")["default"]> {
  mermaidInit ??= import("mermaid").then((m) => {
    m.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
      fontFamily: "ui-monospace, monospace",
    });
    return m.default;
  });
  return mermaidInit;
}

export default function Mermaid({ data, fallback }: RenderProps<string> & { fallback?: ReactNode }) {
  const code = data;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const mermaid = await getMermaid();
        // Unique render id per attempt (mermaid requires distinct
        // ids across calls, including retried renders).
        const id = "voir-mermaid-" + Math.random().toString(36).slice(2);
        const { svg } = await mermaid.render(id, code);
        if (!cancelled) setSvg(svg);
      } catch (err) {
        if (!cancelled) {
          setSvg(null);
          setError((err as Error).message?.split("\n")[0] ?? "mermaid parse error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (svg) {
    return (
      <div
        className="flex justify-center border border-neutral-800 bg-neutral-950 p-3 [&_svg]:mx-auto [&_svg]:max-w-full [&_svg]:h-auto"
        data-testid="mermaid-svg"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  if (error) {
    return (
      <div className="border border-amber-400/30 bg-neutral-900">
        <div className="border-b border-amber-400/20 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-amber-300">
          mermaid: {error}
        </div>
        <pre className="whitespace-pre-wrap p-3 font-mono text-[12px] text-neutral-400 [overflow-wrap:anywhere]">{code}</pre>
      </div>
    );
  }
  return <>{fallback ?? null}</>;
}