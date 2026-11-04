/**
 * html (docs/rich-content.md, module 2): ```html blocks → a
 * sandboxed iframe — the single-file app (Claude-artifacts-style,
 * but protocol-free). The wrapper enforces the security posture:
 *
 *   - sandbox="allow-scripts" WITHOUT allow-same-origin → the
 *     document runs on an opaque origin: voir's cookies,
 *     localStorage and DOM are unreachable; the iframe cannot
 *     touch voir's APIs;
 *   - an injected Content-Security-Policy caps network access to
 *     an allowlist (CDN runtimes + fonts + https images) even
 *     though the sandboxing already blunts same-origin attacks;
 *   - the agent's document keeps its own scripts inline (that's
 *     the point) — 'unsafe-inline' applies to an opaque origin.
 */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { injectCsp, IFRAME_SANDBOX } from "../sandbox";
import type { RenderProps } from "../registry";

/**
 * The CSP injected into every sandboxed document lives in
 * ../sandbox.ts (shared with the d3 module — one allowlist, one
 * place to audit).
 */

/** Inject (or replace) a CSP <meta> into the agent document.
 *  Delegates to sandbox.ts (shared with d3). */
const injectCspInto = injectCsp;

export default function Html({
  data,
  maximized,
  expanded,
  fallback,
}: RenderProps<string> & { fallback?: ReactNode }) {
  const body = useMemo(() => injectCspInto(data), [data]);
  // Frame heights come from the module system's chrome (the shell's
  // expand/collapse + the lightbox's maximized state). The open-
  // standalone affordance rides the shell's ⤢ — the blob route is
  // a power-user path (the maximized frame covers normal use).
  const height = maximized ? "85vh" : expanded ? "70vh" : "320px";
  const srcDoc = body;
  return (
    <iframe
      srcDoc={srcDoc}
      sandbox={IFRAME_SANDBOX}
      title="Agent HTML"
      className="w-full border-0 bg-white"
      style={{ height }}
      data-testid="html-frame"
    />
  );
}