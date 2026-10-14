// Exports every part of an OpenRocket design as exact CAD (STEP), one file per part, and reports
// the rocket's sealed spaces (what is in each, which holes vent them).
//
//   npm run export -- <rocket.ork> [output folder]
//
// Each file holds all copies of that part (e.g. every fin) in their places on the rocket, so
// importing the files into one Onshape document gives one tab per part. assembly.step has
// everything in one file, and report.txt the summary printed here.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { exportRocket, safeFileName } from "../src/export/step.ts";
import { reportText } from "../src/export/report.ts";
import { findCompartments } from "../src/checks/compartments.ts";
import { initOpenCascadeNode, loadOrkFile } from "../src/node/load.ts";

const [input, outArg] = process.argv.slice(2);
if (!input) {
  console.error("usage: npm run export -- <rocket.ork> [output folder]");
  process.exit(2);
}

const model = await loadOrkFile(input);
await initOpenCascadeNode();
const outDir = outArg ?? path.join("out", safeFileName(path.basename(input, path.extname(input))));
await mkdir(outDir, { recursive: true });

const result = exportRocket(model);
for (const p of result.parts) {
  await writeFile(path.join(outDir, p.fileName), Buffer.from(await p.step.arrayBuffer()));
}
await writeFile(path.join(outDir, "assembly.step"), Buffer.from(await result.assembly.arrayBuffer()));
const report = reportText(
  model,
  result.parts.map((p) => ({ ...p, details: p.part.features.map((f) => f.source), errors: [] })),
  findCompartments(model),
);
await writeFile(path.join(outDir, "report.txt"), report);
const skipped = result.skipped.map((s) => `Not built: ${s.reason}\n`).join("");
console.log(report + skipped + `Wrote ${result.parts.length} part files, assembly.step and report.txt to ${outDir}`);
