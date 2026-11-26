// A tiny arithmetic helper. Currently only handles integers —
// see `TASKS.md` for the generic-over-numeric-type refactor.

export function sum(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  let result = 0;
  for (let i = 0; i < b; i++) result = sum(result, a);
  return result;
}
