// Compares a real part (a STEP or STL file, e.g. exported from Onshape) with a nose cone or
// transition of an OpenRocket design, and says what to change in the design so it makes that part:
// shoulder sizes, "Filled", and detail lines for chamfers, rounds, side holes, pockets and nut
// traps. With --write it also saves a copy of the design with the changes made. --flip takes the
// other end of the file's part as its fore end (when both ends are the same size it can't tell).
//
//   npm run match -- <rocket.ork> "<part name>" <part.step | part.stl> [--write <new.ork>] [--flip]

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { allParts, type TransitionPart } from "../src/ork/model.ts";
import { readCad } from "../src/match/cad.ts";
import { applyMatch, matchPart, matchText } from "../src/match/compare.ts";
import { initOpenCascadeNode, modelFromBytes, xmlTools } from "../src/node/load.ts";

const flip = process.argv.includes("--flip");
const args = process.argv.slice(2).filter((a) => a !== "--flip");
const w = args.indexOf("--write");
const output = w >= 0 ? args[w + 1] : undefined;
const [input, name, cadFile] = args.filter((_, i) => w < 0 || (i !== w && i !== w + 1));
if (!input || !name || !cadFile || (w >= 0 && !output)) {
  console.error('usage: npm run match -- <rocket.ork> "<part name>" <part.step | part.stl> [--write <new.ork>] [--flip]');
  process.exit(2);
}
if (output && path.resolve(output) === path.resolve(input)) {
  console.error("Give --write a new file name: the design you started from isn't overwritten.");
  process.exit(2);
}

const bytes = new Uint8Array(await readFile(input));
const model = modelFromBytes(bytes);
const matching = allParts(model).filter((p) => p.name.toLowerCase() === name.toLowerCase());
if (!matching.length) {
  console.error(`${input} has no part called "${name}". Its parts: ${allParts(model).map((p) => p.name).join(", ")}`);
  process.exit(1);
}
const part = matching[0];
if (part.kind !== "transition") {
  console.error(`"${part.name}" is a ${part.type}: only nose cones and transitions can be compared so far.`);
  process.exit(1);
}
if (matching.length > 1) console.log(`(${matching.length} parts are called "${part.name}"; comparing the first.)`);

await initOpenCascadeNode();
const cad = await readCad(new Uint8Array(await readFile(cadFile)), path.basename(cadFile));
const result = matchPart(model, part as TransitionPart, cad, path.basename(cadFile), { flip, progress: (text) => console.log(text) });
console.log("\n" + matchText(result));
if (output) {
  await writeFile(output, applyMatch(bytes, part as TransitionPart, result, xmlTools));
  console.log(`Wrote ${output} with these changes. OpenRocket opens it as usual.`);
}
