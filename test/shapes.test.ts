// Every nose cone / transition shape OpenRocket offers, not just the ones in the fixtures:
// points from OpenRocket's own formula must lie on our outside surface, points one wall thickness
// in (perpendicular to the surface) must lie on our inside surface, the volume must be the exact
// volume of that wall, and the part must come back unchanged from a STEP file.

import { before, test } from "node:test";
import assert from "node:assert/strict";
import { DistanceQuery, exportSTEP, importSTEP, makeCompound, makeVertex, type Shape3D } from "replicad";
import type { RocketModel, ShapeType, TransitionPart } from "../src/ork/model.ts";
import { buildPart } from "../src/geometry/parts.ts";
import { isClipped, shapeRadius, transitionRadius } from "../src/geometry/shapes.ts";
import { solidVolume } from "../src/geometry/measure.ts";
import { initOpenCascadeNode } from "../src/node/load.ts";
import { wallVolume } from "./volumes.ts";

const TOL = 1e-4; // mm

before(() => initOpenCascadeNode());

test("shape formulas give the textbook values", () => {
  const R = 20;
  const L = 100;
  assert.equal(shapeRadius("conical", 50, R, L, 0), 10);
  assert.ok(Math.abs(shapeRadius("ellipsoid", 50, R, L, 0) - R * Math.sqrt(0.75)) < 1e-12);
  assert.ok(Math.abs(shapeRadius("ogive", L, R, L, 1) - R) < 1e-12); // tangent ogive ends at R
  assert.ok(Math.abs(shapeRadius("haack", L, R, L, 0) - R) < 1e-12);
  assert.ok(Math.abs(shapeRadius("power", 25, R, L, 0.5) - R * 0.5) < 1e-12);
  assert.ok(Math.abs(shapeRadius("parabolic", L, R, L, 1) - R) < 1e-12);
});

interface Case {
  shape: ShapeType;
  k: number;
  fore: number;
  aft: number;
  clipped?: boolean;
  wall: number;
}

const cases: Case[] = [];
for (const [shape, ks] of [
  ["conical", [0]],
  ["ogive", [1, 0.5]],
  ["ellipsoid", [0]],
  ["power", [0.5, 0.75]],
  ["parabolic", [0.5, 1]],
  ["haack", [0, 1 / 3]],
] as [ShapeType, number[]][]) {
  for (const k of ks) {
    cases.push({ shape, k, fore: 0, aft: 25, wall: 1.5 }); // nose cone
    cases.push({ shape, k, fore: 15, aft: 25, wall: 1.5 }); // growing transition
    cases.push({ shape, k, fore: 25, aft: 15, wall: 1.5 }); // shrinking transition (boat tail)
    if (shape === "ellipsoid" || shape === "power" || shape === "haack") {
      cases.push({ shape, k, fore: 15, aft: 25, clipped: true, wall: 1.5 });
    }
  }
}

for (const c of cases) {
  const label = `${c.shape}${c.k ? ` k=${c.k.toFixed(2)}` : ""} ${c.fore}->${c.aft} mm${c.clipped ? " clipped" : ""}`;
  test(`${label}: outside follows OpenRocket's formula, wall is ${c.wall} mm thick`, async () => {
    const L = 120;
    const part: TransitionPart = {
      kind: "transition",
      type: c.fore === 0 ? "nosecone" : "transition",
      name: label,
      id: "",
      comment: "",
      length: L,
      instances: [{ x: 0, y: 0, z: 0, angle: 0 }],
      children: [],
      features: [],
      detailErrors: [],
    node: undefined as never,
      shape: c.shape,
      shapeParameter: c.k,
      clipped: c.clipped ?? false,
      foreRadius: c.fore,
      aftRadius: c.aft,
      thickness: c.wall,
      filled: false,
      foreShoulder: { radius: 0, length: 0, thickness: 0, capped: false },
      aftShoulder: { radius: 0, length: 0, thickness: 0, capped: false },
    };
    assert.equal(isClipped(part), c.clipped ?? false);
    const model: RocketModel = { name: "", length: L, bodyLength: L, stages: [], creator: "", formatVersion: "", simulations: [] };
    const built = buildPart(part, model)!;
    const solid = built.solids[0];
    const volume = solidVolume(solid);
    // Where the wall is thicker than the shape's curvature at a sharp end, the inside is trimmed
    // and there's no exact wall to compare with; everywhere else there must be.
    const trimmed = built.warnings.some((w) => w.includes("the inside is trimmed"));
    const exact = wallVolume(part);
    assert.equal(exact === undefined, trimmed, "exact volume worked out unless the wall folds");
    if (exact !== undefined) assert.ok(Math.abs(volume / exact - 1) < 1e-7, `volume ${volume}, exact ${exact}`);
    const back = (await importSTEP(exportSTEP([{ shape: solid, name: label }], { unit: "mm", modelUnit: "mm" }))) as Shape3D;
    assert.equal(back.solids.length, 1, "solids read back from STEP");
    assert.ok(Math.abs(solidVolume(back) / volume - 1) < 1e-7, `volume read back from STEP: ${solidVolume(back)} vs ${volume}`);
    const query = new DistanceQuery(makeCompound(solid.faces));
    const distance = (s: number, r: number, angle: number) => {
      const v = makeVertex([r * Math.cos(angle), r * Math.sin(angle), L - s]);
      const d = query.distanceTo(v);
      v.delete();
      return d;
    };
    // OpenRocket's outside profile as a fine polyline, to tell which offset points really are one
    // wall thickness from the whole surface (where the wall folds at sharp ends, some are closer).
    const outline: [number, number][] = Array.from({ length: 4001 }, (_, i) => {
      const s = (L * i) / 4000;
      return [s, transitionRadius(part, s)];
    });
    const distanceToOutline = (s: number, r: number) => {
      let best = Infinity;
      for (let i = 1; i < outline.length; i++) {
        const [s0, r0] = outline[i - 1];
        const [s1, r1] = outline[i];
        const ds = s1 - s0;
        const dr = r1 - r0;
        const k = Math.max(0, Math.min(1, ((s - s0) * ds + (r - r0) * dr) / (ds * ds + dr * dr)));
        best = Math.min(best, Math.hypot(s - s0 - k * ds, r - r0 - k * dr));
      }
      return best;
    };
    let outerMax = 0;
    let innerMax = 0;
    for (let i = 0; i <= 200; i++) {
      const s = (L * i) / 200;
      const angle = i * 0.7;
      const r = transitionRadius(part, s);
      outerMax = Math.max(outerMax, distance(s, r, angle));
      // One wall thickness in, perpendicular to the surface (slope from the formula).
      if (i === 0 || i === 200) continue;
      const h = 1e-4;
      const slope = (transitionRadius(part, s + h) - transitionRadius(part, s - h)) / (2 * h);
      const n = Math.hypot(1, slope);
      const si = s + (c.wall * slope) / n;
      const ri = r - c.wall / n;
      if (ri < 0.05 || si < 0.05 || si > L - 0.05) continue; // offset leaves the part or reaches the axis
      if (distanceToOutline(si, ri) < c.wall - 1e-3) continue; // inside a fold of the wall
      innerMax = Math.max(innerMax, distance(si, ri, angle));
    }
    assert.ok(outerMax < TOL, `outside surface off by ${outerMax} mm`);
    assert.ok(innerMax < TOL, `inside surface off by ${innerMax} mm`);
  });
}
