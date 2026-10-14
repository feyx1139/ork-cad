// Adds a detail line (holes...) to a component's comment and saves the design as a new .ork.
// The same line can also be typed into the component's Comment tab in OpenRocket.
//
//   npm run add-detail -- <in.ork> <out.ork> "<component name>" "@side-holes count=3 diameter=2 at=40"
//
// The component can also be given by its OpenRocket id. The line is checked (and the part built
// with it) before anything is written, and the input file is never overwritten.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { allParts } from "../src/ork/model.ts";
import { setComment } from "../src/ork/write.ts";
import { parseFeatures } from "../src/features/parse.ts";
import { buildPart } from "../src/geometry/parts.ts";
import { initOpenCascadeNode, modelFromBytes, xmlTools } from "../src/node/load.ts";

const [input, output, component, line] = process.argv.slice(2);
if (!input || !output || !component || !line) {
  console.error('usage: npm run add-detail -- <in.ork> <out.ork> "<component name>" "<@detail line>"');
  process.exit(2);
}
if (path.resolve(input) === path.resolve(output)) {
  console.error("Write to a new file; the input design is never overwritten.");
  process.exit(2);
}

const bytes = new Uint8Array(await readFile(input));
const model = modelFromBytes(bytes);
const matches = allParts(model).filter((p) => p.id === component || p.name.trim().toLowerCase() === component.trim().toLowerCase());
if (matches.length !== 1) {
  const names = allParts(model).map((p) => `  ${p.name}  (id ${p.id})`).join("\n");
  console.error(
    matches.length
      ? `Several components are called "${component}"; give the id instead:\n${names}`
      : `No component called "${component}". Components:\n${names}`,
  );
  process.exit(1);
}
const part = matches[0];
const { features, errors } = parseFeatures(line);
if (errors.length || features.length !== 1) {
  console.error(errors.length ? errors.join("\n") : `"${line}" isn't a detail line (it should start with @).`);
  process.exit(1);
}

// Build the part with the new detail before writing anything.
await initOpenCascadeNode();
part.features = [...part.features, ...features];
const built = buildPart(part, model);
for (const w of built?.warnings ?? []) console.log(`note: ${w}`);

const comment = part.comment.trim() ? `${part.comment.trimEnd()}\n${line.trim()}` : line.trim();
await writeFile(output, setComment(bytes, part.id, comment, xmlTools));
console.log(`Added to "${part.name}": ${line.trim()}\nWrote ${output}`);
