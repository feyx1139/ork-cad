// Details cut into a solid part, each against geometry worked out by hand: the balsa nose cone of
// OpenRocket's "ARC payload rocket" example, which is "Filled" and has a 25 mm shoulder 20.32 mm
// long at its aft end.

import { before, test } from "node:test";
import assert from "node:assert/strict";
import { DistanceQuery, makeCompound, makeVertex, type Shape3D } from "replicad";
import { allParts, type RocketModel, type TransitionPart } from "../src/ork/model.ts";
import { parseFeatures } from "../src/features/parse.ts";
import { buildPart } from "../src/geometry/parts.ts";
import { solidVolume } from "../src/geometry/measure.ts";
import { initOpenCascadeNode, loadOrkFile } from "../src/node/load.ts";
import { fixture } from "./helpers.ts";

let model: RocketModel;
let nose: TransitionPart;
let plain: number;

before(async () => {
  await initOpenCascadeNode();
  model = await loadOrkFile(fixture("arc-payload-rocket.ork"));
  nose = allParts(model).find((p) => p.name === "Nose cone") as TransitionPart;
  assert.ok(nose.filled && nose.aftShoulder.radius === 25);
  plain = solidVolume(solid([]));
});

function solid(details: string[]): Shape3D {
  const { features, errors } = parseFeatures(details.join("\n"));
  assert.deepEqual(errors, []);
  const built = buildPart({ ...nose, features }, model)!;
  assert.equal(built.solids.length, 1);
  return built.solids[0];
}

const removed = (details: string[]) => plain - solidVolume(solid(details));
const close = (actual: number, expected: number, rel = 1e-6) =>
  assert.ok(Math.abs(actual / expected - 1) < rel, `${actual} vs ${expected}`);
const R = 25; // shoulder radius, mm

test("a round pocket into the shoulder", () => {
  close(removed(["@pocket diameter=20 depth=30 end=aft"]), Math.PI * 10 ** 2 * 30);
});

test("a rectangular pocket with rounded corners", () => {
  close(removed(["@pocket size=24x18 depth=25 corner=4 end=aft"]), (24 * 18 - (4 - Math.PI) * 4 ** 2) * 25);
});

test("a rounded rim", () => {
  // The cut is the corner square minus a quarter circle, swept around the axis (Pappus).
  const rho = 4;
  const area = rho ** 2 * (1 - Math.PI / 4);
  const centroid = R - (rho * (10 - 3 * Math.PI)) / (3 * (4 - Math.PI));
  close(removed(["@round end=aft radius=4"]), 2 * Math.PI * centroid * area);
});

test("a lead-in chamfer blended by a round", () => {
  // From where the bevel starts (d = 0) to the end face (d = 6): a 3 mm round, then a straight 30
  // degree line, turned around the axis.
  const rho = 3;
  const th = Math.PI / 6;
  const radiusAt = (d: number) =>
    d <= rho * Math.sin(th)
      ? R - rho + Math.sqrt(rho ** 2 - d ** 2)
      : R - rho * (1 - Math.cos(th)) - (d - rho * Math.sin(th)) * Math.tan(th);
  let expected = 0;
  const n = 200000;
  for (let i = 0; i < n; i++) {
    const d = (6 * (i + 0.5)) / n;
    expected += Math.PI * (R ** 2 - radiusAt(d) ** 2) * (6 / n);
  }
  close(removed(["@chamfer end=aft length=6 angle=30 round=3"]), expected, 1e-5);
});

test("a chamfer given by its inset leaves an end face that much smaller", () => {
  // A 5 mm round tangent to the side, then a straight 45 degree line down to the end face at
  // R - 4, turned around the axis: what's removed is the cylinder they cut into minus the solid
  // under the round (worked out exactly) and under the line (a cone frustum).
  const [rho, th, inset] = [5, Math.PI / 4, 4];
  const c = R - rho;
  const a = rho * Math.sin(th); // the round's length along the axis
  const underRound = Math.PI * ((c ** 2 + rho ** 2) * a - a ** 3 / 3 + c * (a * Math.sqrt(rho ** 2 - a ** 2) + rho ** 2 * Math.asin(a / rho)));
  const [r1, r2] = [R - rho * (1 - Math.cos(th)), R - inset];
  const h = (r1 - r2) / Math.tan(th); // the straight part's length along the axis
  const underLine = (Math.PI * h * (r1 ** 2 + r1 * r2 + r2 ** 2)) / 3;
  close(removed(["@chamfer end=aft inset=4 angle=45 round=5"]), Math.PI * R ** 2 * (a + h) - underRound - underLine);
});

test("a captive M4 nut, the slot it slides in through, and the screw hole", () => {
  const flats = 7.0 + 0.6;
  const t = 3.2 + 0.8;
  const a = flats / 2;
  const slot = a * Math.sqrt(R ** 2 - a ** 2) + R ** 2 * Math.asin(a / R); // from the axis out through the shoulder
  const hexHalf = ((Math.sqrt(3) / 2) * flats ** 2) / 2; // the half of the hexagon behind the slot
  const r = 4.2 / 2;
  const bolt = 12 + t + 3;
  const expected = (slot + hexHalf) * t + Math.PI * r ** 2 * (bolt - t) + (2 / 3) * Math.PI * r ** 3;
  close(removed(["@nut-trap size=M4 depth=12 end=aft angle=-90"]), expected);
});

test("vents through the wall open into the pocket", () => {
  const s = solid(["@pocket diameter=20 depth=60 end=aft", "@side-holes count=6 diameter=2 at=10 from=aft"]);
  const query = new DistanceQuery(makeCompound(s.faces));
  const z = model.length - nose.instances[0].x - (nose.length - 10);
  const at = (deg: number, r: number) => {
    const a = (deg * Math.PI) / 180;
    return query.distanceTo(makeVertex([r * Math.cos(a), r * Math.sin(a), z]));
  };
  for (let k = 0; k < 6; k++) {
    assert.ok(Math.abs(at(60 * k, 15) - 1) < 1e-3, `vent at ${60 * k} degrees`);
    assert.ok(at(60 * k + 30, 15) > 1.5, `solid between vents at ${60 * k + 30} degrees`);
  }
});

test("details together still make one solid", () => {
  const all = ["@pocket diameter=20 depth=60 end=aft", "@side-holes count=6 diameter=2 at=10 from=aft", "@round end=aft radius=4"];
  const pocket = removed([all[0]]);
  const holes = removed([all[1]]);
  const rim = removed([all[2]]);
  // The vents' inner ends fall inside the pocket, so together they remove less than apart.
  const together = removed(all);
  assert.ok(together < pocket + holes + rim && together > pocket + rim, `${together}`);
});
