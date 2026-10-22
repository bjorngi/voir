/**
 * Markdown-aware narration extraction.
 *
 * Agent replies are markdown; a screen reader wants none of it.
 * This module turns a streamed markdown message into speakable
 * chunks, sentence by sentence:
 *
 * - fenced code blocks are skipped entirely (narrating code is
 *   noise; an unterminated fence mid-stream is code in progress —
 *   held until it closes or the message ends, so it is never
 *   spoken);
 * - prose sentences are stripped of formatting before speaking:
 *   headings, bullets, bold/italic markers, inline-code backticks,
 *   link URLs (the label is kept), bare URLs, blockquote markers,
 *   table syntax.
 *
 * Position is tracked in RAW-text coordinates (stable across
 * streaming updates — the spoken prefix of a message never
 * changes), which is what the ChatView narration effect stores
 * per message id.
 */

export interface NarrationChunk {
  /** Markdown-stripped, speakable text. May be "" when the call
   *  only advanced over a skipped code block — keep looping. */
  text: string;
  /** Raw-index position after this chunk. Store as progress. */
  spoken: number;
}

/**
 * Length of the longest prefix of `s` that ends on a completed
 * sentence (up to and including the last ".", "?", "!" or "…"
 * followed by whitespace or end-of-string). 0 when no boundary
 * exists yet.
 */
function sentenceEnd(s: string): number {
  const m = /^[\s\S]*[.!?…](?=\s|$)/.exec(s);
  return m ? m[0].length : 0;
}

/**
 * Strip markdown formatting from a prose chunk so it reads
 * naturally when spoken. Chunks passed here never contain fenced
 * code (the chunker skips fences); inline formatting only.
 */
export function stripMarkdown(s: string): string {
  return (
    s
      // images: keep alt text (if any)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      // links: keep the label, drop the URL
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // bare URLs: never worth hearing
      .replace(/https?:\/\/\S+/g, "")
      // strikethrough
      .replace(/~~([^~]+)~~/g, "$1")
      // bold
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      // italic (asterisks)
      .replace(/\*([^*]+)\*/g, "$1")
      // italic (underscores at word boundaries — snake_case stays)
      .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2")
      // inline code: keep the content
      .replace(/`([^`]*)`/g, "$1")
      // headings — and while they're still headings, give
      // unterminated ones a period so the narration pauses
      // before the line that follows
      .replace(/^(#{1,6}[ \t]+[^.\n!?…]*[^\s.!?…])[ \t]*$/gm, "$1.")
      .replace(/^#{1,6}[ \t]+/gm, "")
      // bullets
      .replace(/^[ \t]*[-*+][ \t]+/gm, "")
      // numbered list markers
      .replace(/^[ \t]*\d+\.[ \t]+/gm, "")
      // blockquote markers
      .replace(/^[ \t]*>[ \t]?/gm, "")
      // horizontal rules
      .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "")
      // table separator rows (| --- | :---: |)
      .replace(/^[ \t|:-]*\|[ \t|:-]*$/gm, "")
      // remaining table pipes → pause-ish spacing
      .replace(/\|/g, " ")
      // flow: collapse all whitespace
      .replace(/\s+/g, " ")
      .trim()
  );
}

const FENCE_LINE = /(?:^|\n)[ \t]*```/;

/**
 * Extract the next speakable chunk from `raw` starting at the
 * `spoken` raw-index.
 *
 * - `final: true`  → the message is complete: flush prose tails,
 *   swallow trailing code, always report the end position.
 * - `final: false` → streaming: only emit complete sentences;
 *   return null when nothing is speakable yet (the caller keeps
 *   its old position and waits).
 *
 * Every non-null result advances (`spoken` strictly greater than
 * the input position). A result with empty `text` means progress
 * was made by skipping a code block — call again.
 */
export function nextNarrationChunk(
  raw: string,
  spoken: number,
  opts: { final: boolean },
): NarrationChunk | null {
  let i = spoken;
  while (i < raw.length) {
    // Next fenced-code block start at or after i (line-based).
    // Careful with the match position: when the regex consumes a
    // leading "\n", the fence line starts one char AFTER the
    // match — otherwise the line starts AT the match.
    const rest = raw.slice(i);
    const fence = FENCE_LINE.exec(rest);
    const proseEnd = !fence
      ? raw.length
      : fence.index === 0 && rest[0] !== "\n"
        ? i
        : i + fence.index + 1;
    const prose = raw.slice(i, proseEnd);

    if (prose.trim().length > 0) {
      const cut = sentenceEnd(prose);
      if (cut > 0) {
        return { text: stripMarkdown(prose.slice(0, cut)), spoken: i + cut };
      }
      if (opts.final || fence) {
        // No sentence-final punctuation, but this prose section is
        // complete — the message ended, or a code fence closes it.
        return { text: stripMarkdown(prose), spoken: proseEnd };
      }
      return null; // prose still streaming
    }

    // Only whitespace before the next fence (or EOF).
    if (!fence) {
      return opts.final ? { text: "", spoken: raw.length } : null;
    }

    // Skip the fenced block: find its closing fence line.
    const afterOpen = raw.indexOf("\n", proseEnd);
    const searchFrom = afterOpen === -1 ? raw.length : afterOpen + 1;
    const close = FENCE_LINE.exec(raw.slice(searchFrom));
    if (close) {
      const closeRest = raw.slice(searchFrom);
      const closeLineStart =
        close.index === 0 && closeRest[0] !== "\n"
          ? searchFrom
          : searchFrom + close.index + 1;
      const afterClose = raw.indexOf("\n", closeLineStart);
      i = afterClose === -1 ? raw.length : afterClose + 1;
      continue; // prose may follow the code block
    }
    // Unterminated fence: code in progress. Hold while streaming;
    // on final, the whole tail is code — never speak it.
    return opts.final ? { text: "", spoken: raw.length } : null;
  }
  return opts.final ? { text: "", spoken: Math.max(spoken, raw.length) } : null;
}