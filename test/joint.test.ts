// "@screw-joint": a body tube printed in two pieces that screw together, on the long aft tube of
// OpenRocket's "ARC payload rocket" example (56.3 mm, 762 mm long, fins 680 to 756 mm along it).

import { before, test } from "node:test";
import assert from "node:assert/strict";
import { DistanceQuery, importSTEP, makeCompound, makeVertex, type Shape3D } from "replicad";
import { allParts, type CylinderPart, type RocketModel } from "../src/ork/model.ts";
import { FeatureError, parseFeatures, type ScrewJoint } from "../src/features/parse.ts";
import { jointLayout, jointPieces } from "../src/features/joint.ts";
import { halfWidth, makeTooth } from "../src/geometry/thread.ts";
import { buildPart } from "../src/geometry/parts.ts";
import { solidVolume } from "../src/geometry/measure.ts";
import { exportRocket, PRINT_MESH } from "../src/export/files.ts";
import { badEdges, meshArea, meshVolume, readSTL } from "../src/geometry/stl.ts";
import { initOpenCascadeNode, loadOrkFile } from "../src/node/load.ts";
import { fixture } from "./helpers.ts";

let model: RocketModel;
let tube: CylinderPart;

before(async () => {
  await initOpenCascadeNode();
  model = await loadOrkFile(fixture("arc-payload-rocket.ork"));
  tube = allParts(model).filter((p) => p.type === "bodytube")[1] as CylinderPart;
  assert.equal(Math.round(tube.length), 762);
});

function joint(line: string): ScrewJoint {
  const { features, errors } = parseFeatures(line);
  assert.deepEqual(errors, []);
  return features[0] as ScrewJoint;
}

/** The tube with these detail lines, built: its pieces (fore first) and warnings. */
function build(...lines: string[]): { pieces: Shape3D[]; warnings: string[] } {
  const features = lines.flatMap((l) => parseFeatures(l).features);
  const built = buildPart({ ...tube, features }, model)!;
  return { pieces: jointPieces(built.solids[0]), warnings: built.warnings };
}

test("screw joint: defaults, and settings that can't work", () => {
  const j = joint("@screw-joint at=200 from=aft");
  assert.deepEqual(
    { at: j.at, from: j.from, pitch: j.pitch, length: j.length, depth: j.depth, clearance: j.clearance, detent: j.detent, angle: j.angle },
    { at: 200, from: "aft", pitch: 3, length: 15, depth: 1, clearance: 0.3, detent: true, angle: 0 },
  );
  assert.equal(joint("@screw-joint at=50 pitch=4 detent=off").length, 20);
  assert.match(parseFeatures("@screw-joint at=50 pitch=3 depth=1.5").errors[0], /less than half the pitch/);
  assert.match(parseFeatures("@screw-joint at=50 clearance=1").errors[0], /less than the thread depth/);
  assert.match(parseFeatures("@screw-joint at=50 detent=maybe").errors[0], /on or off/);
});

test("a thread's ridge is exact: its volume is the trapezoid carried round the helix", () => {
  const t = { root: 26, crest: 27, pitch: 3, crestFlat: 0.5 };
  const inner = 25.8;
  const tooth = makeTooth(t, inner, 0, 15)!;
  // A helical sweep of a section in a plane through the axis keeps volume like a revolve does:
  // V = (angle turned) × ∫ r dA. The trapezoid's width at radius r is 2 halfWidth(r).
  const hw = halfWidth(t, inner);
  const turned = (2 * Math.PI * (15 - 2 * hw)) / t.pitch;
  const integral = ((a: number, b: number) => {
    // ∫ r · 2 (c/2 + crest - r) dr from a to b
    const c = t.crestFlat / 2 + t.crest;
    const F = (r: number) => c * r * r - (2 * r ** 3) / 3;
    return F(b) - F(a);
  })(inner, t.crest);
  const exact = turned * integral;
  assert.ok(Math.abs(solidVolume(tooth) / exact - 1) < 1e-7, `${solidVolume(tooth)} vs ${exact}`);
});

test("the two pieces screw home without touching, with the clearance as play", () => {
  const { pieces, warnings } = build("@screw-joint at=200 from=aft");
  assert.deepEqual(warnings, []);
  assert.equal(pieces.length, 2);
  const [fore, aft] = pieces;
  const j = jointLayout(tube, joint("@screw-joint at=200 from=aft"));
  const zSplit = model.length - tube.instances[0].x - j.split;
  // The tube ends meet at the split; the plug stands 3 + 15 mm above it; the outside is unchanged.
  const [[fx0, , fz0], [fx1, , fz1]] = fore.boundingBox.bounds;
  const [[ax0, , az0], [ax1, , az1]] = aft.boundingBox.bounds;
  assert.ok(Math.abs(fz0 - zSplit) < 1e-6, `fore piece ends at ${fz0}, split at ${zSplit}`);
  assert.ok(Math.abs(az1 - (zSplit + 18)) < 1e-6, `plug top at ${az1}`);
  assert.ok(Math.abs(fz1 - (model.length - tube.instances[0].x)) < 1e-6 && Math.abs(az0 - (fz1 - tube.length)) < 1e-6);
  for (const x of [fx0, fx1, ax0, ax1]) assert.ok(Math.abs(Math.abs(x) - tube.outerRadius) < 1e-6);
  // Screwed home they don't overlap, the detent's bumps sitting in their dimples.
  assert.ok(solidVolume(fore.intersect(aft)) < 1e-6);
  // Without the detent, the flanks are 0.3 mm apart along the axis: pulled 0.25 mm apart the
  // plug's thread still doesn't touch the collar's, pulled 0.4 mm it does.
  const [f, a] = build("@screw-joint at=200 from=aft detent=off").pieces;
  assert.ok(solidVolume(f.intersect(a.clone().translate([0, 0, -0.25]))) < 1e-6);
  assert.ok(solidVolume(f.intersect(a.clone().translate([0, 0, -0.4]))) > 1);
});

test("the detent: bumps on the plug, dimples in the collar", () => {
  const plain = build("@screw-joint at=200 from=aft detent=off").pieces;
  const clicks = build("@screw-joint at=200 from=aft").pieces;
  assert.ok(solidVolume(clicks[1]) > solidVolume(plain[1]) + 0.1, "bumps add plastic to the plug");
  assert.ok(solidVolume(clicks[0]) < solidVolume(plain[0]) - 0.1, "dimples take it from the collar");
});

test("what the joint can't go across, or near", () => {
  // The fins run from 680 to 756 mm along the tube: split there and it couldn't unscrew.
  assert.throws(() => build("@screw-joint at=60 from=aft"), (e: Error) => e instanceof FeatureError && /runs across the joint/.test(e.message));
  // Too close to either end for the collar or the plug's base.
  assert.throws(() => build("@screw-joint at=10"), /tube fore of the split/);
  assert.throws(() => build("@screw-joint at=3 from=aft"), /tube aft of the split/);
  // The fore centering ring (633 to 635 mm) is inside the joint here.
  const { warnings } = build("@screw-joint at=130 from=aft");
  assert.ok(warnings.some((w) => /"Centering ring" .* in the way of the screw joint/.test(w)), warnings.join("\n"));
});

test("the export has each piece as its own STL and STEP file", async () => {
  const features = parseFeatures("@screw-joint at=200 from=aft").features;
  const original = tube.features;
  tube.features = [...original, ...features];
  try {
    const result = exportRocket(model, { step: true });
    const files = result.parts.filter((p) => p.part === tube);
    assert.deepEqual(
      files.map((p) => p.fileName.replace(/^\d+ /, "")),
      ["Body tube (fore piece).stl", "Body tube (aft piece).stl"],
    );
    const exact = jointPieces(buildPart(tube, model)!.solids[0]);
    for (const [i, p] of files.entries()) {
      const mesh = readSTL(p.stl);
      assert.equal(badEdges(mesh), 0, `${p.fileName}: not a closed surface`);
      const volume = solidVolume(exact[i]);
      assert.ok(Math.abs(p.volume - volume) < 1e-6);
      assert.ok(Math.abs(meshVolume(mesh) - volume) <= meshArea(mesh) * PRINT_MESH.tolerance, `${p.fileName}: ${meshVolume(mesh)} vs ${volume}`);
      const query = new DistanceQuery(makeCompound(exact[i].faces));
      const n = mesh.vertices.length / 3;
      let worst = 0;
      for (let k = 0; k < n; k += Math.max(1, Math.floor(n / 300))) {
        const v = makeVertex([mesh.vertices[3 * k], mesh.vertices[3 * k + 1], mesh.vertices[3 * k + 2]]);
        worst = Math.max(worst, query.distanceTo(v));
        v.delete();
      }
      assert.ok(worst < 1e-4, `${p.fileName}: a corner is ${worst} mm off the surface`);
      const back = (await importSTEP(new Blob([p.step!.slice()]))) as Shape3D;
      assert.ok(Math.abs(solidVolume(back) / volume - 1) < 1e-7, `${p.fileName}: STEP volume ${solidVolume(back)} vs ${volume}`);
    }
  } finally {
    tube.features = original;
  }
});
