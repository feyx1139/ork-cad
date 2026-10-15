// Fins printed as part of their body tube ("@one-piece"), canted or not, on OpenRocket's "ARC
// payload rocket" example: three single-fin sets on the 762 mm aft tube (56.3 mm), 680 to 756 mm
// along it. (OpenRocket's own geometry for canted fins is checked in openrocket.test.ts.)

import { before, test } from "node:test";
import assert from "node:assert/strict";
import type { Shape3D } from "replicad";
import { allParts, type CylinderPart, type FinSetPart, type RocketModel } from "../src/ork/model.ts";
import { parseFeatures } from "../src/features/parse.ts";
import { addAutoDetails } from "../src/features/auto.ts";
import { jointPieces } from "../src/features/joint.ts";
import { buildPart } from "../src/geometry/parts.ts";
import { solidVolume } from "../src/geometry/measure.ts";
import { exportRocket } from "../src/export/files.ts";
import { badEdges, readSTL } from "../src/geometry/stl.ts";
import { initOpenCascadeNode, loadOrkFile } from "../src/node/load.ts";
import { fixture } from "./helpers.ts";

let model: RocketModel;
let tube: CylinderPart;
let fins: FinSetPart[];

before(async () => {
  await initOpenCascadeNode();
  model = await loadOrkFile(fixture("arc-payload-rocket.ork"));
  tube = allParts(model).filter((p) => p.type === "bodytube")[1] as CylinderPart;
  fins = tube.children.filter((c): c is FinSetPart => c.kind === "finset");
  assert.equal(fins.length, 3);
});

const total = (solids: Shape3D[]) => solids.reduce((sum, s) => sum + solidVolume(s), 0);

/** Builds the tube with its fin sets set to `cant` (degrees) and these detail lines, then puts them back. */
function withFins<T>(cant: number, lines: string, f: () => T): T {
  const saved = fins.map((p) => [p.cant, p.features] as const);
  const savedTube = tube.features;
  try {
    for (const p of fins) {
      p.cant = (cant * Math.PI) / 180;
      p.features = parseFeatures(lines).features;
    }
    return f();
  } finally {
    fins.forEach((p, i) => ([p.cant, p.features] = saved[i]));
    tube.features = savedTube;
  }
}

test("one piece: the fins join the tube, their roots meeting its curve", () => {
  const plain = total(buildPart(tube, model)!.solids);
  const separate = withFins(0, "", () => total(fins.flatMap((p) => buildPart(p, model)!.solids)));
  const { solids, finsBuilt } = withFins(0, "@one-piece", () => ({
    solids: buildPart(tube, model)!.solids,
    finsBuilt: fins.map((p) => buildPart(p, model)!),
  }));
  assert.equal(solids.length, 1);
  assert.equal(solids[0].solids.length, 1, "one solid: the fins are joined on");
  for (const b of finsBuilt) assert.deepEqual(b.solids, []);
  // A separate fin's flat root touches the round tube only along its middle; joined on, the fin
  // also fills the sliver between its root (the line x = R) and the tube's curve, across its
  // thickness t: 2aR minus the integral of sqrt(R² - y²) from -a to a (a = t/2), along the root.
  const R = tube.outerRadius;
  const a = fins[0].thickness / 2;
  const sliver = 2 * a * R - (a * Math.sqrt(R * R - a * a) + R * R * Math.asin(a / R));
  const slivers = fins.reduce((sum, p) => sum + p.length * sliver, 0);
  const exact = plain + separate + slivers;
  assert.ok(Math.abs(solidVolume(solids[0]) / exact - 1) < 1e-7, `${solidVolume(solids[0])} vs ${exact}`);
});

test("one piece, canted: the same fins as printed on their own, joined to the tube", () => {
  const plain = total(buildPart(tube, model)!.solids);
  // A canted fin on its own already has its root cut to the tube's curve (see buildFin).
  const separate = withFins(4, "", () => total(fins.flatMap((p) => buildPart(p, model)!.solids)));
  const joined = withFins(4, "@one-piece", () => buildPart(tube, model)!.solids[0]);
  assert.equal(joined.solids.length, 1);
  assert.ok(Math.abs(solidVolume(joined) / (plain + separate) - 1) < 1e-7, `${solidVolume(joined)} vs ${plain + separate}`);
  // Canted, the fin's root ends stand to the side: 4° of a 75.4 mm root turns its ends 2.6 mm.
  const fin = withFins(4, "", () => buildPart(fins[0], model)!.solids[0]);
  const [[, y0], [, y1]] = fin.boundingBox.bounds;
  assert.ok(y1 - y0 > 2 * 37.7 * Math.sin((4 * Math.PI) / 180), `${y1 - y0} mm across`);
});

test("one piece with a screw joint: the fins go on the piece they're on", () => {
  const before = withFins(0, "", () => {
    tube.features = parseFeatures("@screw-joint at=200 from=aft").features;
    return jointPieces(buildPart(tube, model)!.solids[0]).map((s) => solidVolume(s));
  });
  const separate = withFins(0, "", () => total(fins.flatMap((p) => buildPart(p, model)!.solids)));
  const after = withFins(0, "@one-piece", () => {
    tube.features = parseFeatures("@screw-joint at=200 from=aft").features;
    return jointPieces(buildPart(tube, model)!.solids[0]);
  });
  assert.equal(after.length, 2);
  assert.ok(Math.abs(solidVolume(after[0]) - before[0]) < 1e-6, `the fore piece is unchanged: ${solidVolume(after[0])} vs ${before[0]}`);
  assert.ok(solidVolume(after[1]) - before[1] > separate, "the aft piece has the fins");
});

test("one piece in the files: the tube's STL holds the fins, and the fins have none", () => {
  withFins(3, "@one-piece", () => {
    const files = exportRocket(model).parts;
    assert.ok(!files.some((f) => f.part.kind === "finset"));
    const file = files.find((f) => f.part === tube)!;
    assert.equal(badEdges(readSTL(file.stl)), 0, "a closed surface");
    assert.ok(Math.abs(file.volume - solidVolume(buildPart(tube, model)!.solids[0])) < 1e-6);
  });
});

test("automatic: printed fins on a printed tube, unless they have tabs", async () => {
  // OpenRocket's printable example: PETG fins on a PETG fin can ("export the fin can and its
  // children as one .OBJ file").
  const printable = await loadOrkFile(fixture("3d-printable-nose-cone-and-fins.ork"));
  addAutoDetails(printable);
  const set = allParts(printable).find((p) => p.kind === "finset")!;
  assert.deepEqual(set.features.map((f) => f.source), ["@one-piece"]);
  assert.match(set.features[0].auto!, /Printed as part of Printable Fin Can and Motor Mount/);

  // Turned off on the fin set, or fins with tabs: printed on their own.
  set.comment = "@auto one-piece=off";
  set.autoSettings = parseFeatures(set.comment).auto;
  addAutoDetails(printable);
  assert.deepEqual(set.features, []);
  const tabs = await loadOrkFile(fixture("fin-tabs.ork"));
  for (const p of allParts(tabs)) {
    if (p.node?.fields.get("material")) p.node.fields.get("material")!.text = "PLA";
  }
  addAutoDetails(tabs);
  assert.ok(allParts(tabs).every((p) => !p.features.some((f) => f.kind === "one-piece")));
});
