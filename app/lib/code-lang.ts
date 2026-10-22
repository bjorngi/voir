/**
 * File path → prism language id for syntax highlighting.
 *
 * prism-react-renderer bundles a curated language set (typescript,
 * tsx, jsx, javascript, json, markdown, go, python, c, clike, css,
 * markup, yaml, sql, graphql, java, kotlin, php, swift, …). Anything
 * outside that set maps to "text" — plain rendering, no highlight —
 * rather than a wrong-language soup.
 */

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  webmanifest: "json",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  astro: "markup",
  svelte: "markup",
  css: "css",
  scss: "css",
  less: "css",
  py: "python",
  pyi: "python",
  pyw: "python",
  go: "go",
  c: "c",
  h: "c",
  cpp: "c",
  cc: "c",
  cxx: "c",
  hpp: "c",
  hh: "c",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  php: "php",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  swift: "swift",
  m: "objectivec",
};

export function langOf(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "text";
  return EXT_LANG[path.slice(dot + 1).toLowerCase()] ?? "text";
}