// Parts and details in plain words, what a detail does shown in 3D, and the form that writes detail
// lines: on OpenRocket's "3D printable nose cone and fins" example and the ARC-style test rocket.

import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session } from "../web/session.ts";
import { KINDS, kindsFor, lineOf } from "../web/detail-form.ts";
import { parseFeatures, type Feature } from "../src/features/parse.ts";
import { describeFeature } from "../src/features/describe.ts";
import { aboutPart } from "../src/ork/about.ts";
import { allParts } from "../src/ork/model.ts";
import { initOpenCascadeNode, loadOrkFile, xmlTools } from "../src/node/load.ts";
import { solidVolume } from "../src/geometry/measure.ts";
import { buildPart } from "../src/geometry/parts.ts";
import { fixture } from "./helpers.ts";

before(() => initOpenCascadeNode());

const one = (line: string): Feature => {
  const { features, errors } = parseFeatures(line);
  assert.deepEqual(errors, []);
  return features[0];
};

test("details in words", async () => {
  const model = await loadOrkFile(fixture("3d-printable-nose-cone-and-fins.ork"));
  const nose = allParts(model).find((p) => p.type === "nosecone")!;
  const holes = describeFeature(one("@side-holes count=3 diameter=2 at=60 angle=45"), nose);
  assert.equal(holes.title, "3 holes through the wall");
  assert.equal(
    holes.text,
    "3 holes, 2 mm across, straight through the wall 60 mm from the top end of Printable nose cone, spaced evenly around it (120° apart), the first 45° round from the first fin.",
  );
  assert.match(describeFeature(one("@pocket size=24x18 depth=40 corner=4 end=aft round=3"), nose).text, /24 × 18 mm rectangular \(corners rounded 4 mm\) pocket cut 40 mm deep .* bottom end, its opening rounded off \(3 mm\)/);
  assert.match(describeFeature(one("@nut-trap size=M4 depth=12"), nose).text, /holds an M4 hex nut 12 mm in from the bottom end, with a 4\.2 mm hole/);
  assert.match(describeFeature(one("@chamfer end=aft length=6 angle=30 round=3"), nose).text, /bevelled over 6 mm, at 30° to the rocket's axis, blended in with a 3 mm round/);
  assert.match(describeFeature(one("@side-holes count=1 diameter=2 at=-5"), nose).text, /5 mm into the top shoulder, it in line with the first fin/);
  // Every kind of detail has words.
  for (const line of ["@end-holes count=4 diameter=3 radius=12 end=fore", "@round end=fore radius=3", "@solid", "@screw-joint at=105 from=aft", "@one-piece"]) {
    const d = describeFeature(one(line), nose);
    assert.ok(d.title && d.text.length > 20, line);
  }
});

test("parts in words: what each is, its size, and where", async () => {
  const model = await loadOrkFile(fixture("3d-printable-nose-cone-and-fins.ork"));
  const about = Object.fromEntries(allParts(model).filter((p) => p.kind !== "other").map((p) => [p.name, aboutPart(p)]));
  assert.equal(about["Printable nose cone"].label, "Nose cone: ogive, 24.8 mm across, 100 mm long");
  assert.deepEqual([about["Printable nose cone"].from, about["Printable nose cone"].to], [0, 100]);
  assert.match(about["Trapezoidal fin set"].label, /^Fin set: 3 trapezoidal fins, /);
  assert.match(about["Inner Tube"].label, /^Motor tube: /);
  assert.match(about["Centering ring"].about, /motor tube in the middle/);
});

test("what a detail does, in 3D: exactly the plastic it cuts away or adds", () => {
  const FILE = "3d-printable-nose-cone-and-fins.ork";
  const session = Session.open(new Uint8Array(readFileSync(fixture(FILE))), FILE, xmlTools);
  const views = session.buildAll();
  const nose = views.find((v) => v.name === "Printable nose cone")!;
  const [holed] = session.setDetails(nose.key, "@side-holes count=3 diameter=2 at=60 angle=45");
  const written = holed.written[0];
  assert.equal(written.title, "3 holes through the wall");
  // The holes cut away exactly the plastic the nose cone loses with them.
  const shape = session.detailShape(nose.key, written.index!);
  assert.ok(shape.removed && !shape.added);
  const part = session.part(nose.key);
  const without = solidVolume(buildPart({ ...part, features: part.features.filter((f) => f.auto) }, session.model)!.solids[0]);
  assert.ok(Math.abs(without - holed.volume - meshVolume(shape.removed)) < 0.01 * (without - holed.volume), `${without - holed.volume} mm³ removed`);
  // The automatic lead-in is shown too, and the fins printed with the fin can are the fins.
  assert.ok(session.detailShape(nose.key, holed.auto[0].index).removed);
  const fins = views.find((v) => v.name === "Trapezoidal fin set")!;
  const finShape = session.detailShape(fins.key, fins.auto[0].index);
  assert.ok(finShape.added && !finShape.removed);
});

test("the form writes lines that read back, for every kind, on the parts they fit", () => {
  for (const kind of KINDS) {
    const line = lineOf(kind, {});
    assert.deepEqual(parseFeatures(line).errors, [], `${kind.kind}: ${line}`);
    assert.ok(kind.on.length > 0);
  }
  const pocket = KINDS.find((k) => k.kind === "pocket")!;
  assert.equal(lineOf(pocket, { shape: "round", diameter: "21", depth: "50", round: "4" }), "@pocket diameter=21 depth=50 round=4");
  assert.equal(lineOf(pocket, { width: "24", height: "18", corner: "4" }), "@pocket size=24x18 corner=4 depth=40");
  const chamfer = KINDS.find((k) => k.kind === "chamfer")!;
  assert.equal(lineOf(chamfer, { end: "aft", by: "length", amount: "6", angle: "30" }), "@chamfer end=aft length=6 angle=30");
  // Settings the form has no box for are kept.
  const nut = KINDS.find((k) => k.kind === "nut-trap")!;
  assert.equal(lineOf(nut, { size: "M5", depth: "10" }, [["flats", "8.4"]]), "@nut-trap size=M5 depth=10 flats=8.4");
  // A nose cone can have holes and pockets but not a screw joint; fins only one-piece.
  assert.ok(kindsFor("nosecone").some((k) => k.kind === "pocket") && !kindsFor("nosecone").some((k) => k.kind === "screw-joint"));
  assert.deepEqual(kindsFor("trapezoidfinset").map((k) => k.kind), ["one-piece"]);
});

function meshVolume(m: { vertices: Float32Array; triangles: Uint32Array }): number {
  let v = 0;
  const p = (i: number) => [m.vertices[3 * i], m.vertices[3 * i + 1], m.vertices[3 * i + 2]];
  for (let t = 0; t < m.triangles.length; t += 3) {
    const [a, b, c] = [p(m.triangles[t]), p(m.triangles[t + 1]), p(m.triangles[t + 2])];
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return Math.abs(v);
}
