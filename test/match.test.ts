// Comparing a real part (a STEP or STL file) with the design. Each "real part" here is the design's
// part built with known changes, written as a STEP or STL file and moved and turned the way a CAD
// program might have it; the comparison has to find exactly those changes again, and the part
// built with them has to match the file.

import { before, test } from "node:test";
import assert from "node:assert/strict";
import { exportSTEP, type Shape3D } from "replicad";
import { allParts, type RocketModel, type TransitionPart } from "../src/ork/model.ts";
import { parseFeatures } from "../src/features/parse.ts";
import { buildPart } from "../src/geometry/parts.ts";
import { solidVolume } from "../src/geometry/measure.ts";
import { stlOf } from "../src/export/files.ts";
import { readSTL, writeSTL } from "../src/geometry/stl.ts";
import { readCad } from "../src/match/cad.ts";
import { applyMatch, matchPart, type MatchResult } from "../src/match/compare.ts";
import { initOpenCascadeNode, loadOrkFile, modelFromBytes, xmlTools } from "../src/node/load.ts";
import { fixture } from "./helpers.ts";

before(() => initOpenCascadeNode());

/** The part as it would be with these OpenRocket changes and detail lines. */
function realPart(model: RocketModel, part: TransitionPart, changes: Partial<TransitionPart>, lines: string[]): Shape3D {
  const { features, errors } = parseFeatures(lines.join("\n"));
  assert.deepEqual(errors, []);
  return buildPart({ ...part, ...changes, features }, model)!.solids[0];
}

async function stepFile(shape: Shape3D): Promise<Uint8Array> {
  return new Uint8Array(await exportSTEP([{ shape, name: "part" }], { unit: "mm", modelUnit: "mm" }).arrayBuffer());
}

const changed = (r: MatchResult) => Object.fromEntries(r.changes.map((c) => [c.field, c.to]));

function matches(r: MatchResult): void {
  assert.deepEqual(r.check.differences, [], "nothing left over");
  assert.ok(r.check.maxDistance < 0.05, `surfaces ${r.check.maxDistance} mm apart`);
}

// ---------------------------------------------------------------------------------------------
// A solid nose cone: OpenRocket's ARC payload rocket example (balsa ogive, 25 mm shoulder).

const NOSE_LINES = [
  "@chamfer end=aft inset=2 angle=30 round=3",
  "@side-holes count=6 diameter=2.5 at=150 angle=15",
  "@pocket size=16x12 depth=25 corner=3 end=aft angle=20",
];

async function arcNose() {
  const model = await loadOrkFile(fixture("arc-payload-rocket.ork"));
  const nose = allParts(model).find((p) => p.name === "Nose cone") as TransitionPart;
  const real = realPart(model, nose, { aftShoulder: { ...nose.aftShoulder, radius: 24.8, length: 30 } }, NOSE_LINES);
  return { model, nose, real };
}

test("a nose cone from a STEP file: the shoulder, its lead-in, side holes through the curved wall and a pocket", async () => {
  const { model, nose, real } = await arcNose();
  // As a CAD program might have it: turned 40 degrees about its axis and moved.
  const file = await stepFile(real.clone().rotate(40, [0, 0, 0], [0, 0, 1]).translate([5, -3, -800]));
  const r = matchPart(model, nose, await readCad(file, "nose.step"), "nose.step");
  assert.deepEqual(changed(r), { aftshoulderradius: "24.8 mm", aftshoulderlength: "30 mm" });
  // Angles are measured from the file's X axis, so they're 40 degrees on.
  assert.deepEqual(r.added, [
    "@chamfer end=aft inset=2 angle=30 round=3",
    "@side-holes count=6 diameter=2.5 at=150 angle=55",
    "@pocket size=16x12 depth=25 corner=3 end=aft angle=60",
  ]);
  assert.deepEqual(r.removed, []);
  matches(r);
  assert.ok(Math.abs(r.check.builtVolume / r.check.fileVolume - 1) < 1e-6, `${r.check.builtVolume} vs ${r.check.fileVolume}`);
});

test("the same nose from an STL in inches, tilted: the same changes", async () => {
  const { model, nose, real } = await arcNose();
  const turned = real.clone().rotate(57, [10, 20, 30], [1, -2, 0.5]).translate([40, 0, -300]);
  const mesh = readSTL(stlOf(turned, "nose"));
  const inches = writeSTL({ vertices: mesh.vertices.map((v) => v / 25.4), triangles: mesh.triangles }, "nose");
  const r = matchPart(model, nose, await readCad(inches, "nose.stl"), "nose.stl");
  assert.equal(r.scale, 25.4);
  assert.deepEqual(changed(r), { aftshoulderradius: "24.8 mm", aftshoulderlength: "30 mm" });
  const angleFree = (lines: string[]) => lines.map((l) => l.replace(/ angle=[-\d.]+$/, ""));
  assert.deepEqual(angleFree(r.added), angleFree(NOSE_LINES));
  matches(r);
});

// ---------------------------------------------------------------------------------------------
// A transition between two tubes of the same size, like a printed coupler with an altimeter bay.

const ROCKET = `<?xml version='1.0' encoding='utf-8'?>
<openrocket version="1.10" creator="OpenRocket 24.12"><rocket><name>Two tubes</name><id>r</id>
<subcomponents><stage><name>Sustainer</name><id>s</id><subcomponents>
<bodytube><name>Upper tube</name><id>u</id><length>0.2</length><thickness>0.0005</thickness><radius>0.0208</radius></bodytube>
<transition><name>Bay</name><id>t</id><comment>printed</comment><length>0.012</length><thickness>0.002</thickness><shape>conical</shape>
<foreradius>auto</foreradius><aftradius>auto</aftradius>
<foreshoulderradius>0.0203</foreshoulderradius><foreshoulderlength>0.03</foreshoulderlength>
<foreshoulderthickness>0.002</foreshoulderthickness><foreshouldercapped>false</foreshouldercapped>
<aftshoulderradius>0.0203</aftshoulderradius><aftshoulderlength>0.025</aftshoulderlength>
<aftshoulderthickness>0.002</aftshoulderthickness><aftshouldercapped>false</aftshouldercapped></transition>
<bodytube><name>Lower tube</name><id>l</id><length>0.2</length><thickness>0.0005</thickness><radius>0.0208</radius></bodytube>
</subcomponents></stage></subcomponents></rocket></openrocket>`;

const BAY_LINES = [
  "@round end=fore radius=3",
  "@chamfer end=aft inset=2 angle=30 round=2",
  "@side-holes count=8 diameter=1.5 at=3",
  "@pocket size=16x12 depth=30 corner=3 end=fore",
  "@nut-trap size=M3 depth=8 end=aft angle=60",
];

test("a solid transition: shoulders, Filled, a rounded rim, a lead-in, vents, a pocket and a nut trap; and the changes written", async () => {
  const bytes = new TextEncoder().encode(ROCKET);
  const model = modelFromBytes(bytes);
  const bay = allParts(model).find((p) => p.name === "Bay") as TransitionPart;
  const real = realPart(
    model,
    bay,
    { filled: true, foreShoulder: { ...bay.foreShoulder, radius: 20.1, length: 25 }, aftShoulder: { ...bay.aftShoulder, radius: 19.6, length: 28 } },
    BAY_LINES,
  );
  for (const [name, file] of [
    ["bay.step", await stepFile(real.clone().translate([0, 0, -300]))],
    ["bay.stl", stlOf(real, "bay")],
  ] as const) {
    const r = matchPart(model, bay, await readCad(file, name), name);
    assert.deepEqual(
      changed(r),
      {
        foreshoulderradius: "20.1 mm",
        foreshoulderlength: "25 mm",
        aftshoulderradius: "19.6 mm",
        aftshoulderlength: "28 mm",
        thickness: "ticked",
      },
      name,
    );
    assert.deepEqual(r.added, BAY_LINES, name);
    matches(r);
    assert.ok(r.notes.some((n) => /same size, so the end toward the file's Z axis/.test(n)), "says which end it took as fore");

    // Written into the design, the part comes out as the file.
    const after = modelFromBytes(applyMatch(bytes, bay, r, xmlTools));
    const now = allParts(after).find((p) => p.name === "Bay") as TransitionPart;
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    assert.ok(now.filled && near(now.foreShoulder.radius, 20.1) && near(now.aftShoulder.length, 28), JSON.stringify(now.aftShoulder));
    assert.equal(now.comment, ["printed", ...BAY_LINES].join("\n"));
    const v = solidVolume(buildPart(now, after)!.solids[0]);
    assert.ok(Math.abs(v / solidVolume(real) - 1) < 1e-9, `${v} vs ${solidVolume(real)}`);
  }
});

test("compared the other way round, the shoulders swap", async () => {
  const model = modelFromBytes(new TextEncoder().encode(ROCKET));
  const bay = allParts(model).find((p) => p.name === "Bay") as TransitionPart;
  const real = realPart(model, bay, { foreShoulder: { ...bay.foreShoulder, length: 20 } }, []);
  const r = matchPart(model, bay, await readCad(stlOf(real, "bay"), "bay.stl"), "bay.stl", { flip: true });
  assert.deepEqual(changed(r), { foreshoulderlength: "25 mm", aftshoulderlength: "20 mm" });
});
