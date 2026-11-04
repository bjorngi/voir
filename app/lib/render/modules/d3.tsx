/**
 * d3 (docs/rich-content.md, module 9): ```d3 blocks = the agent
 * writes bespoke JavaScript; voir runs it in the shared sandbox
 * (opaque origin, injected CSP) with d3 v7 preloaded from the CDN.
 * This is the free-form tier below uPlot's structured cards:
 * force graphs, treemaps, custom plots — arbitrary graphics from
 * data the agent embeds inline in its own code.
 *
 * Recipe the agents get (in the module doc):
 *   - `d3` and `#viz` are in scope; size to innerWidth/innerHeight;
 *   - a thrown/render error shows as text, never a blank frame.
 */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { buildD3Doc, IFRAME_SANDBOX } from "../sandbox";
import type { RenderProps } from "../registry";

export default function D3({
  data,
  maximized,
  expanded,
  fallback,
}: RenderProps<string> & { fallback?: ReactNode }) {
  const srcDoc = useMemo(() => buildD3Doc(data), [data]);
  // Frame heights come from the chrome (see html.tsx).
  const height = maximized ? "85vh" : expanded ? "70vh" : "340px";
  return (
    <iframe
      srcDoc={srcDoc}
      sandbox={IFRAME_SANDBOX}
      title="Agent d3 viz"
      className="w-full border-0 bg-neutral-950"
      style={{ height }}
    />
  );
}