// Exports every part of an OpenRocket design as an STL file for printing, and reports the rocket's
// sealed spaces (what is in each, which holes vent them).
//
//   npm run export -- <rocket.ork> [output folder] [--step]
//
// Each STL holds one copy of its part (a fin set's file is one fin; its name says how many to
// print), in its place on the rocket. --step also writes exact STEP files for Onshape:
// assembly.step with the whole rocket, every part a separate named component in its place, and a
// STEP file per part. report.txt has the summary printed here.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { exportRocket, safeFileName } from "../src/export/files.ts";
import { reportText } from "../src/export/report.ts";
import { findCompartments } from "../src/checks/compartments.ts";
import { initOpenCascadeNode, loadOrkFile } from "../src/node/load.ts";

const args = process.argv.slice(2);
const step = args.includes("--step");
const [input, outArg] = args.filter((a) => a !== "--step");
if (!input) {
  console.error("usage: npm run export -- <rocket.ork> [output folder] [--step]");
  process.exit(2);
}

const model = await loadOrkFile(input);
await initOpenCascadeNode();
const outDir = outArg ?? path.join("out", safeFileName(path.basename(input, path.extname(input))));
await mkdir(outDir, { recursive: true });

const result = exportRocket(model, { step });
for (const p of result.parts) {
  await writeFile(path.join(outDir, p.fileName), p.stl);
  if (p.step) await writeFile(path.join(outDir, p.fileName.replace(/( \(print \d+\))?\.stl$/, ".step")), p.step);
}
if (result.assembly) await writeFile(path.join(outDir, "assembly.step"), result.assembly);
const report = reportText(
  model,
  result.parts.map((p) => ({ ...p, details: p.part.features.map((f) => f.source), errors: [] })),
  findCompartments(model),
);
await writeFile(path.join(outDir, "report.txt"), report);
const skipped = result.skipped.map((s) => `Not built: ${s.reason}\n`).join("");
const files = step ? "STL and STEP files, assembly.step" : "STL files";
console.log(report + skipped + `Wrote ${result.parts.length} parts as ${files} and report.txt to ${outDir}`);
