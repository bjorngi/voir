// Tiny JSON-summary helper used by the demo CLI in `cli.ts`.
//
// Returns a short human-readable shape: `array(3)` for arrays,
// `object{a, b}` for objects, the JS type name for primitives.

export function summarize(data: unknown): string {
  if (data === null) return "null";
  if (Array.isArray(data)) return `array(${data.length})`;
  if (typeof data === "object") {
    const keys = Object.keys(data as Record<string, unknown>);
    return `object{${keys.join(", ")}}`;
  }
  return typeof data;
}
