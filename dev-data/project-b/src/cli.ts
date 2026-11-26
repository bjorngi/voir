// Demo CLI entry point: read a JSON file and print a summary.
//
//   node --import tsx src/cli.ts <path-to-json>

import { readFileSync } from "node:fs";
import { summarize } from "./parse";

const path = process.argv[2];
if (!path) {
  console.error("usage: cli <path-to-json>");
  process.exit(2);
}
const text = readFileSync(path, "utf8");
console.log(summarize(JSON.parse(text)));
