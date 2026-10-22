/**
 * Shared syntax-highlighted code block — the "shower" style used by
 * the Changes view, now with a language label, a wrap toggle, and
 * horizontal scrolling when unwrapped.
 *
 * Used by the Files tab (whole files, markdown code fences) and by
 * the diff shower (per line, `HighlightedInline`, with the add/del
 * row colors kept).
 *
 * Wrap off:  `whitespace-pre` + `overflow-x-auto` — long lines
 *            scroll sideways (rows sized to their content).
 * Wrap on:   `whitespace-pre-wrap` — lines fold to the viewport,
 *            the phone-friendly default for prose-ish code.
 */
import { useState } from "react";
import { Highlight, type Language } from "prism-react-renderer";
import { langOf } from "~/lib/code-lang";

export type { Language };

/** Dim neutral palette with voir's amber as the keyword accent. */
export const voirTheme = {
  plain: { color: "#d4d4d8", backgroundColor: "transparent" },
  styles: [
    {
      types: ["comment", "prolog", "doctype", "cdata"],
      style: { color: "#71717a", fontStyle: "italic" as const },
    },
    { types: ["punctuation"], style: { color: "#a1a1aa" } },
    {
      types: [
        "keyword",
        "control",
        "directive",
        "unit",
        "important",
        "atrule",
        "tag",
        "selector",
      ],
      style: { color: "#fcd34d" },
    },
    {
      types: ["string", "char", "attr-value", "regex"],
      style: { color: "#6ee7b7" },
    },
    {
      types: ["number", "boolean", "symbol", "constant", "builtin"],
      style: { color: "#fdba74" },
    },
    {
      types: ["function", "function-variable", "method", "attr-name"],
      style: { color: "#7dd3fc" },
    },
    { types: ["class-name", "maybe-class-name"], style: { color: "#fde68a" } },
    {
      types: ["operator", "entity", "url", "variable"],
      style: { color: "#f9a8d4" },
    },
    { types: ["deleted"], style: { color: "#fda4af" } },
    { types: ["inserted"], style: { color: "#6ee7b7" } },
  ],
};

/**
 * One line's text, syntax-highlighted inline (no block element) —
 * for the diff shower, which owns the row backgrounds and gutters.
 * Multi-line token context is lost per line; acceptable at phone
 * sizes.
 */
export function HighlightedInline({
  text,
  lang,
}: {
  text: string;
  lang: Language;
}) {
  if (!text) return null;
  return (
    <Highlight theme={voirTheme} code={text} language={lang}>
      {({ tokens, getTokenProps }) => (
        <>
          {(tokens[0] ?? []).map((token, k) => (
            <span key={k} {...getTokenProps({ token })} />
          ))}
        </>
      )}
    </Highlight>
  );
}

export function CodeBlock({
  code,
  path,
  language,
  /** Show the wrap toggle (and language label) header. Default: yes. */
  header = true,
  maxHeightClass = "max-h-[70vh]",
}: {
  code: string;
  /** For the language label + automatic language detection. */
  path?: string;
  /** Explicit prism language id; wins over `path` detection. */
  language?: string;
  header?: boolean;
  maxHeightClass?: string;
}) {
  const [wrap, setWrap] = useState(false);
  const lang = (language ?? (path ? langOf(path) : "text")) as Language;

  return (
    <div className="overflow-hidden border border-neutral-800 bg-neutral-950">
      {header && (
        <div className="flex items-center justify-between gap-2 border-b border-neutral-900 bg-neutral-950 px-2 py-1">
          <span className="truncate font-mono text-[10px] uppercase tracking-widest text-neutral-600">
            {lang === "text" && path
              ? path.slice(path.lastIndexOf("/") + 1)
              : lang}
          </span>
          <button
            type="button"
            onClick={() => setWrap((w) => !w)}
            aria-pressed={wrap}
            title="Toggle long-line wrapping"
            className={
              "shrink-0 font-mono text-[10px] uppercase tracking-widest " +
              (wrap
                ? "text-amber-300"
                : "text-neutral-600 active:text-neutral-300")
            }
          >
            wrap {wrap ? "on" : "off"}
          </button>
        </div>
      )}
      <Highlight theme={voirTheme} code={code.replace(/\n$/, "")} language={lang}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre
            className={
              `${maxHeightClass} overflow-auto p-2 font-mono text-[12px] leading-snug ` +
              (wrap ? "whitespace-pre-wrap" : "whitespace-pre")
            }
          >
            {tokens.map((line, i) => (
              <div
                key={i}
                {...getLineProps({ line })}
                className={wrap ? undefined : "min-w-max"}
              >
                {line.map((token, k) => (
                  <span key={k} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
}