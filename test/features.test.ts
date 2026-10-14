// Details from component comments: the "@" line syntax, and the holes they cut, on OpenRocket's
// "3D printable nose cone and fins" and "ARC payload rocket" examples.

import { before, test } from "node:test";
import assert from "node:assert/strict";
import { DistanceQuery, makeCompound, makeVertex } from "replicad";
import { allParts, type Part, type RocketModel, type TransitionPart } from "../src/ork/model.ts";
import { FeatureError, parseFeatures, parseLength } from "../src/features/parse.ts";
import { buildPart } from "../src/geometry/parts.ts";
import { solidVolume } from "../src/geometry/measure.ts";
import { transitionRadius } from "../src/geometry/shapes.ts";
import { initOpenCascadeNode, loadOrkFile } from "../src/node/load.ts";
import { fixture } from "./helpers.ts";

before(() => initOpenCascadeNode());

test("detail lines: values, units and defaults", () => {
  const { features, errors } = parseFeatures(
    "Printed in PETG.\n@side-holes count=3 diameter=2.5 at=40 angle=45\n  @END-HOLES count=4, diameter=1/8in, radius=1.2cm\n",
  );
  assert.deepEqual(errors, []);
  assert.equal(features.length, 2);
  const [side, end] = features;
  assert.equal(side.kind, "side-holes");
  if (side.kind === "side-holes") {
    assert.equal(side.count, 3);
    assert.equal(side.diameter, 2.5);
    assert.equal(side.at, 40);
    assert.equal(side.from, "fore");
    assert.ok(Math.abs(side.angle - Math.PI / 4) < 1e-12);
  }
  assert.equal(end.kind, "end-holes");
  if (end.kind === "end-holes") {
    assert.ok(Math.abs(end.diameter - 3.175) < 1e-12);
    assert.equal(end.radius, 12);
    assert.equal(end.end, undefined);
  }
  assert.equal(parseLength('0.25"'), 6.35);
  assert.equal(parseLength("-5"), -5);
});

test("detail lines: mistakes are reported with the line", () => {
  const bad = [
    ["@vent-holes count=2", /unknown detail/],
    ["@side-holes count=3 diam=2 at=10", /unknown setting "diam"/],
    ["@side-holes count=3 at=10", /diameter is missing/],
    ["@side-holes count=0 diameter=2 at=10", /whole number/],
    ["@side-holes diameter=2 at=10 from=up", /fore, aft or middle/],
    ["@side-holes diameter=two at=10", /isn't a length/],
    ["@end-holes count=3 diameter=2", /need a radius/],
    ["@side-holes diameter=2 diameter=3 at=1", /given twice/],
  ] as const;
  for (const [line, message] of bad) {
    const { features, errors } = parseFeatures(line);
    assert.equal(features.length, 0, line);
    assert.equal(errors.length, 1, line);
    assert.match(errors[0], message, line);
    assert.ok(errors[0].includes(line), "the message quotes the line");
  }
});

test("detail lines: pockets, nut traps, chamfers and rounds", () => {
  const { features, errors } = parseFeatures(
    [
      "@pocket size=24x18 depth=40 corner=4",
      "@pocket diameter=20 depth=30 end=aft angle=90",
      "@nut-trap size=#8-32 depth=10",
      "@nut-trap size=m4 depth=14 end=fore bolt=30 flats=7.4",
      "@chamfer end=aft length=6 angle=30 round=3",
      "@round end=fore radius=1/8in",
    ].join("\n"),
  );
  assert.deepEqual(errors, []);
  const [rect, round, nut8, nut4, chamfer, rim] = features;
  assert.deepEqual(rect.kind === "pocket" && rect.shape, { kind: "rect", width: 24, height: 18, corner: 4 });
  assert.ok(rect.kind === "pocket" && rect.end === "fore" && rect.depth === 40);
  assert.deepEqual(round.kind === "pocket" && round.shape, { kind: "round", diameter: 20 });
  assert.ok(nut8.kind === "nut-trap" && nut8.end === "aft" && nut8.hole === 4.4);
  assert.ok(nut8.kind === "nut-trap" && Math.abs(nut8.flats - 9.33) < 1e-9 && Math.abs(nut8.thickness - 3.98) < 1e-9);
  assert.ok(nut8.kind === "nut-trap" && Math.abs(nut8.bolt - (10 + 3.98 + 3)) < 1e-9);
  assert.ok(nut4.kind === "nut-trap" && nut4.flats === 7.4 && nut4.bolt === 30 && nut4.end === "fore");
  assert.ok(chamfer.kind === "chamfer" && Math.abs(chamfer.angle - Math.PI / 6) < 1e-12 && chamfer.round === 3);
  assert.ok(rim.kind === "round" && rim.radius === 3.175);

  const bad = [
    ["@pocket depth=10", /size \(WxH\) or a diameter/],
    ["@pocket size=24 depth=10", /should look like 24x18/],
    ["@pocket size=10x10 corner=6 depth=5", /corner must be/],
    ["@nut-trap size=M7 depth=5", /unknown size "M7"/],
    ["@chamfer length=5", /end is missing/],
    ["@chamfer end=aft length=5 angle=95", /between 0 and 90/],
  ] as const;
  for (const [line, message] of bad) {
    const r = parseFeatures(line);
    assert.equal(r.errors.length, 1, line);
    assert.match(r.errors[0], message, line);
  }
});

test("a chamfer can be given by how far in it cuts at the end", () => {
  const [c] = parseFeatures("@chamfer end=aft inset=2 angle=30 round=3").features;
  // The round turns in 3 (1 - cos 30); the straight part covers the rest of the 2 mm at 30 degrees.
  const th = Math.PI / 6;
  const expected = 3 * Math.sin(th) + (2 - 3 * (1 - Math.cos(th))) / Math.tan(th);
  assert.ok(c.kind === "chamfer" && Math.abs(c.length - expected) < 1e-12 && c.round === 3, JSON.stringify(c));
  const [plain] = parseFeatures("@chamfer end=fore inset=2").features;
  assert.ok(plain.kind === "chamfer" && Math.abs(plain.length - 2) < 1e-12, "45 degrees without a round: as long as it is deep");

  const bad = [
    ["@chamfer end=aft", /a length .* or an inset/],
    ["@chamfer end=aft length=5 inset=2", /either length or inset/],
    ["@chamfer end=aft inset=1 round=5", /round is too big for the inset/],
  ] as const;
  for (const [line, message] of bad) {
    const r = parseFeatures(line);
    assert.equal(r.errors.length, 1, line);
    assert.match(r.errors[0], message, line);
  }
});

/** A fixture rocket and a way to pick its parts by name. */
async function rocket(name: string): Promise<{ model: RocketModel; part: (name: string) => Part }> {
  const model = await loadOrkFile(fixture(`${name}.ork`));
  return { model, part: (n) => allParts(model).find((p) => p.name === n)! };
}

function withDetail(part: Part, line: string): Part {
  const { features, errors } = parseFeatures(line);
  assert.deepEqual(errors, []);
  part.features = features;
  return part;
}

const volumeOf = (part: Part, model: RocketModel) => solidVolume(buildPart(part, model)!.solids[0]);
const close = (actual: number, expected: number, rel: number, what: string) =>
  assert.ok(Math.abs(actual / expected - 1) < rel, `${what}: ${actual} vs ${expected}`);

test("pockets and nut traps need a solid part", async () => {
  const { model, part } = await rocket("3d-printable-nose-cone-and-fins");
  const nose = withDetail(part("Printable nose cone"), "@pocket size=10x8 depth=20 end=aft");
  assert.throws(() => buildPart(nose, model), (e: unknown) => e instanceof FeatureError && /tick "Filled"/.test(e.message));
});

test("side holes go through the nose cone's curved wall where asked", async () => {
  const { model, part } = await rocket("3d-printable-nose-cone-and-fins");
  const nose = part("Printable nose cone") as TransitionPart;
  const plain = volumeOf(nose, model);
  const holed = buildPart(withDetail(nose, "@side-holes count=3 diameter=2 at=60 angle=45"), model)!.solids[0];
  close(plain - solidVolume(holed), 3 * wallInHole(nose, 60, 1), 1e-6, "material removed");

  // Half way through the wall: open at the hole angles, solid half way between them.
  const query = new DistanceQuery(makeCompound(holed.faces));
  const s = 60;
  const rMid = (transitionRadius(nose, s) + insideRadius(nose, s)) / 2;
  const z = model.length - nose.instances[0].x - s;
  const distance = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    return query.distanceTo(makeVertex([rMid * Math.cos(a), rMid * Math.sin(a), z]));
  };
  for (const deg of [45, 165, 285]) assert.ok(Math.abs(distance(deg) - 1) < 1e-3, `hole at ${deg} degrees`);
  for (const deg of [105, 225, 345]) assert.ok(distance(deg) < nose.thickness / 2 + 1e-3, `wall at ${deg} degrees`);
});

test("end holes go through the nose cone's shoulder cap and through a bulkhead", async () => {
  const printable = await rocket("3d-printable-nose-cone-and-fins");
  const nose = printable.part("Printable nose cone") as TransitionPart;
  const plainNose = volumeOf(nose, printable.model);
  const holedNose = volumeOf(withDetail(nose, "@end-holes count=3 diameter=2 radius=5"), printable.model);
  close(plainNose - holedNose, 3 * Math.PI * 1 ** 2 * nose.aftShoulder.thickness, 1e-6, "removed from the cap");

  const arc = await rocket("arc-payload-rocket");
  const bulkhead = arc.part("Bulkhead");
  const plain = volumeOf(bulkhead, arc.model);
  const holed = volumeOf(withDetail(bulkhead, "@end-holes count=4 diameter=3 radius=15"), arc.model);
  close(plain - holed, 4 * Math.PI * 1.5 ** 2 * bulkhead.length, 1e-6, "removed from the bulkhead");
});

test("details that don't fit are refused with a reason", async () => {
  const printable = await rocket("3d-printable-nose-cone-and-fins");
  const arc = await rocket("arc-payload-rocket");
  const dual = await rocket("dual-parachute-deployment");
  const cases: [typeof arc, string, string, RegExp][] = [
    [printable, "Printable nose cone", "@side-holes diameter=2 at=200", /run off the part/],
    [printable, "Printable nose cone", "@side-holes count=200 diameter=2 at=60", /overlapping/],
    [printable, "Printable nose cone", "@end-holes count=2 diameter=3 radius=9", /inside the shoulder wall/],
    [dual, "Nose cone", "@end-holes diameter=3", /neither shoulder is capped/],
    [arc, "Nose cone", "@end-holes diameter=3", /the part is solid/],
    [arc, "Nose cone", "@pocket diameter=49 depth=10 end=aft", /leaving 0.5 mm of wall/],
    [arc, "Nose cone", "@chamfer end=fore length=5", /isn't a straight tube or shoulder/],
    [dual, "Rail Button", "@side-holes diameter=2 at=1", /can't go in a railbutton/],
    [printable, "Paper Body Tube -- DO NOT PRINT", "@end-holes diameter=3", /not a bodytube/],
    [printable, "Launch lug", "@side-holes diameter=1 at=5", /centred on the rocket axis/],
  ];
  for (const [{ model, part }, name, line, message] of cases) {
    const p = withDetail(part(name), line);
    assert.throws(() => buildPart(p, model), (e: unknown) => e instanceof FeatureError && message.test(e.message), line);
    p.features = [];
  }
});

test("holes another part covers are pointed out", async () => {
  const { model, part } = await rocket("3d-printable-nose-cone-and-fins");
  const nose = withDetail(part("Printable nose cone"), "@side-holes count=2 diameter=2 at=-10 from=aft");
  const built = buildPart(nose, model)!;
  assert.ok(
    built.warnings.some((w) => /aft shoulder sits inside "Paper Body Tube -- DO NOT PRINT"/.test(w)),
    built.warnings.join("\n"),
  );
  const tube = withDetail(part("Paper Body Tube -- DO NOT PRINT"), "@side-holes diameter=2 at=10");
  const builtTube = buildPart(tube, model)!;
  assert.ok(builtTube.warnings.some((w) => /shoulder of "Printable nose cone" sits inside here/.test(w)), builtTube.warnings.join("\n"));
});

/**
 * Inside radius of a hollow nose cone or transition at s: where the outside, moved in by the wall
 * thickness perpendicular to itself, crosses s.
 */
function insideRadius(t: TransitionPart, s: number): number {
  const moved = (u: number): [number, number] => {
    const h = 1e-6;
    const [a, b] = [Math.max(u - h, 0), Math.min(u + h, t.length)];
    const slope = (transitionRadius(t, b) - transitionRadius(t, a)) / (b - a);
    const n = Math.hypot(1, slope);
    return [u + (t.thickness * slope) / n, transitionRadius(t, u) - t.thickness / n];
  };
  let [lo, hi] = [0, t.length];
  for (let k = 0; k < 100; k++) {
    const m = (lo + hi) / 2;
    if (moved(m)[0] < s) lo = m;
    else hi = m;
  }
  return moved((lo + hi) / 2)[1];
}

/**
 * Wall material inside one round hole of radius r drilled straight out from the axis at s: over
 * the hole's cross-section (v along the axis, w across), the length of each line through the wall.
 * Integrated in polar coordinates over the cross-section, Gauss-Legendre out from the centre and
 * evenly spaced around.
 */
function wallInHole(t: TransitionPart, s: number, r: number): number {
  const [nodes, weights] = gaussLegendre(24);
  const turns = 96;
  let sum = 0;
  for (let i = 0; i < nodes.length; i++) {
    const rho = (r * (nodes[i] + 1)) / 2;
    for (let j = 0; j < turns; j++) {
      const phi = (2 * Math.PI * j) / turns;
      const [v, w] = [rho * Math.cos(phi), rho * Math.sin(phi)];
      const R = transitionRadius(t, s + v);
      const Ri = insideRadius(t, s + v);
      const through = Math.sqrt(R * R - w * w) - Math.sqrt(Math.max(Ri * Ri - w * w, 0));
      sum += ((weights[i] * r) / 2) * ((2 * Math.PI) / turns) * rho * through;
    }
  }
  return sum;
}

/** Gauss-Legendre nodes and weights on [-1, 1], by Newton's method on the Legendre polynomial. */
function gaussLegendre(n: number): [number[], number[]] {
  const nodes: number[] = [];
  const weights: number[] = [];
  for (let i = 1; i <= n; i++) {
    let x = Math.cos((Math.PI * (i - 0.25)) / (n + 0.5));
    let dp = 0;
    for (let k = 0; k < 100; k++) {
      let [p0, p1] = [1, x];
      for (let m = 2; m <= n; m++) [p0, p1] = [p1, ((2 * m - 1) * x * p1 - (m - 1) * p0) / m];
      dp = (n * (x * p1 - p0)) / (x * x - 1);
      const dx = p1 / dp;
      x -= dx;
      if (Math.abs(dx) < 1e-15) break;
    }
    nodes.push(x);
    weights.push(2 / ((1 - x * x) * dp * dp));
  }
  return [nodes, weights];
}

