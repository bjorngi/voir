/**
 * Sandbox plumbing for script-bearing rich-content modules
 * (docs/rich-content.md — trust tiers). Shared by the `html` and
 * `d3` modules.
 *
 * The security posture, compact:
 *   - srcdoc documents run in <iframe sandbox="allow-scripts">
 *     WITHOUT allow-same-origin → an opaque origin: voir's
 *     cookies, localStorage and DOM are unreachable, the frame
 *     cannot touch voir's APIs;
 *   - every document gets an injected Content-Security-Policy
 *     capping network access to a strict allowlist; everything
 *     else fails closed;
 *   - agent code embedded INSIDE a host script tag is escaped
 *     against `</script>` breakout.
 */

/**
 * The CSP injected into every sandboxed document. Narrow
 * allowlist; the CDN entries exist for import-map runtimes
 * (React/SPA single-file apps) and the d3 module.
 */
export const SANDBOX_CSP = [
  "default-src 'none'",
  // The document's own <script> + CDN runtimes (React, d3, …).
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://esm.sh https://unpkg.com",
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://esm.sh https://unpkg.com",
  "font-src https://fonts.gstatic.com",
  "img-src data: blob: https:",
  "connect-src https://cdn.jsdelivr.net https://esm.sh https://unpkg.com",
  // Sandboxed frames don't navigate themselves.
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Attribute value for the iframe's sandbox attr. */
export const IFRAME_SANDBOX = "allow-scripts";

/** Neutralize `</script` breakouts when embedding code into a
 *  host script tag. `<\/script` is inert to the parser and
 *  evaluates identically inside string literals. */
export function escapeScriptClose(code: string): string {
  return code.replace(/<\/script/gi, "<\\/script");
}

/** Inject (or add) a CSP <meta> into an agent-authored document. */
export function injectCsp(body: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP.replaceAll('"', "&quot;")}">`;
  const headOpen = /<head[^>]*>/i;
  if (headOpen.test(body)) {
    return body.replace(headOpen, (m) => m + meta);
  }
  const htmlOpen = /<html[^>]*>/i;
  if (htmlOpen.test(body)) {
    return body.replace(htmlOpen, (m) => m + "<head>" + meta + "</head>");
  }
  return meta + body;
}

/**
 * Build the d3 sandbox document: d3 v7 from the CDN (module
 * script), a dark base, a #viz mount, then the agent's code
 * (escaped) inside try/catch so failures render as text instead
 * of a blank frame. `type="module"` gives user code top-level
 * await for free.
 */
export function buildD3Doc(userCode: string): string {
  const code = escapeScriptClose(userCode);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP.replaceAll('"', "&quot;")}">
<style>
  html, body { margin: 0; background: #0b0d10; color: #e5e5e5;
    font-family: ui-monospace, monospace; }
  #viz { padding: 4px; }
  text { fill: #d4d4d4; }
  .axis line, .axis path { stroke: #404040; }
  a { color: #93c5fd; }
</style>
</head>
<body>
<div id="viz"></div>
<script type="module">
try {
  const d3 = await import("https://cdn.jsdelivr.net/npm/d3@7/+esm");
  const viz = document.getElementById("viz");
${code}
} catch (e) {
  const pre = document.createElement("pre");
  pre.style.cssText = "color:#f87171;font-size:11px;white-space:pre-wrap;padding:8px";
  pre.textContent = "d3 error: " + (e && e.message ? e.message : String(e));
  document.body.appendChild(pre);
}
</${"script"}>
</body>
</html>`;
}