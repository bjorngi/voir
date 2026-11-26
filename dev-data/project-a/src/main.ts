// Demo entry point for Project A.
//
// A small factorial-like calculation built on top of the
// `sum` helper in `util.ts`. Currently throws on `n < 0` —
// see `TASKS.md`.

import { sum } from "./util";

export function main(n: number): number {
  if (n === 0) return 1;
  let result = 1;
  for (let i = 1; i <= n; i++) result = sum(result, i);
  return result;
}

if (import.meta.main) {
  console.log(main(5));
}
