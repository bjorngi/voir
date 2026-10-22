/**
 * Dictation transcript assembly.
 *
 * Why this isn't a plain string concat: mobile speech recognizers
 * are wildly inconsistent about what they hand you in a result.
 * Observed failure modes (varying by OS/browser):
 *
 *   - the same final segment is delivered more than once;
 *   - a "final" contains the entire transcript so far, not just
 *     the new segment (cumulative delivery);
 *   - the session ends on every pause and the restart (which
 *     keeps long dictation alive) re-captures a few words the
 *     previous session already finalized.
 *
 * All three produce repeated words if new material is appended
 * verbatim. `appendFinal` therefore merges on overlap: if the
 * beginning of the new material repeats the end of what we have,
 * the repeat is trimmed and only genuinely new words are added —
 * and if the new material is fully contained in what we already
 * have, nothing is added at all. Overlap is compared
 * case-insensitively with punctuation stripped (recognizers
 * re-punctuate re-deliveries slightly differently).
 *
 * Trade-off, accepted deliberately: genuinely repeating a short
 * phrase in normal speech can be mistaken for a re-delivery and
 * the second occurrence trimmed. Dictation output is a draft
 * the user reviews before sending, so under-duplication beats
 * stuttering repetition.
 */

/** Join two transcript fragments with a single space between. */
export function joinFor(base: string, more: string): string {
  if (!base) return more;
  if (!more) return base;
  const needsSpace = !/\s$/.test(base) && !/^\s/.test(more);
  return base + (needsSpace ? " " : "") + more;
}

const TRIM_PUNCT = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** Comparison form of a word: lowercase, no leading/trailing punctuation. */
function normWord(w: string): string {
  return w.toLowerCase().replace(TRIM_PUNCT, "");
}

function words(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean);
}

/**
 * Append final transcript material to the accumulated dictation,
 * trimming any overlap between the end of `base` and the start of
 * `more` (see the header comment for why). Pure function.
 */
export function appendFinal(base: string, more: string): string {
  const b = words(base);
  const m = words(more);
  if (m.length === 0) return base;
  if (b.length === 0) return m.join(" ");

  // Largest k such that the last k words of base equal the first
  // k words of more (normalized comparison).
  let k = Math.min(b.length, m.length);
  for (; k > 0; k--) {
    let match = true;
    for (let i = 0; i < k; i++) {
      if (normWord(b[b.length - k + i]) !== normWord(m[i])) {
        match = false;
        break;
      }
    }
    if (match) break;
  }

  if (k === m.length) {
    // The new material adds nothing we don't already have.
    return base;
  }
  if (k > 0) {
    // Drop the repeated prefix, keep the new tail.
    return joinFor(base, m.slice(k).join(" "));
  }
  return joinFor(base, m.join(" "));
}