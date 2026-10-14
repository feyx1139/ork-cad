// Our solids against OpenRocket itself, on the designs in test/fixtures:
//  1. volumes against OpenRocket's mass model, and
//  2. every vertex of OpenRocket's own OBJ export against our surfaces.
// OpenRocket's OBJ export simplifies some things on purpose (see the notes below), so for nose
// cones and transitions only the outside surface has to match; the rest is reported.

import { before, test } from "node:test";
import assert from "node:assert/strict";
import { DistanceQuery, makeCompound, makeVertex, type Shape3D } from "replicad";
import { allParts, type FinSetPart, type Part, type RocketModel, type TransitionPart } from "../src/ork/model.ts";
import { buildPart } from "../src/geometry/parts.ts";
import { solidVolume } from "../src/geometry/measure.ts";
import { transitionRadius } from "../src/geometry/shapes.ts";
import { initOpenCascadeNode, loadOrkFile } from "../src/node/load.ts";
import { fixture, readObj, readReference, ROCKETS } from "./helpers.ts";
import { openRocketVolume, wallVolume } from "./volumes.ts";

const ON_SURFACE = 1e-3; // mm; OpenRocket writes OBJ coordinates as 32-bit floats

before(() => initOpenCascadeNode());

const total = (solids: Shape3D[]) => solids.reduce((sum, s) => sum + solidVolume(s), 0);

/** The part as OpenRocket has it: an elliptical fin's tab where OpenRocket moves it on opening. */
const asOpenRocket = (part: Part): Part => (part.kind === "finset" ? { ...part, tab: part.openRocketTab } : part);

/** OpenRocket's FinSet.CrossSection volume factors: it takes off a little for rounded or airfoil edges. */
const EDGE_FACTOR: Record<string, number> = { square: 1, rounded: 0.99, airfoil: 0.85 };

for (const rocket of ROCKETS) {
  test(`${rocket}: part volumes match OpenRocket's mass model`, async (t) => {
    const model = await loadOrkFile(fixture(`${rocket}.ork`));
    const ref = await readReference(rocket);
    const byId = new Map(ref.components.map((c) => [c.id, c]));
    for (const part of allParts(model)) {
      const built = buildPart(asOpenRocket(part), model);
      if (!built) continue;
      const c = byId.get(part.id)!;
      const refVolume = (c.componentVolume ?? c.componentMass / c.materialDensity!) * 1e9; // mm³
      const ours = total(built.solids);
      const copies = part.instances.length;
      t.diagnostic(
        `${part.name}: ours ${(ours / 1000).toFixed(4)} cm³, OpenRocket ${(refVolume / 1000).toFixed(4)} cm³, ` +
          `ratio ${(ours / refVolume).toFixed(6)}`,
      );

      if (part.kind === "transition") {
        // OpenRocket adds up 128 slices of the wall, each one's inside radius found from the
        // slope of that slice (test/volumes.ts). Its number must be exactly that formula on our
        // dimensions, and ours exactly the wall we draw (thickness perpendicular to the surface).
        const formula = openRocketVolume(part) * copies;
        assert.ok(Math.abs(refVolume / formula - 1) < 1e-9, `${part.name}: OpenRocket ${refVolume}, its formula ${formula}`);
        const exact = wallVolume(part);
        assert.ok(exact !== undefined, `${part.name}: no exact volume to compare with`);
        assert.ok(Math.abs(ours / (exact * copies) - 1) < 1e-7, `${part.name}: ours ${ours}, exact ${exact * copies}`);
        continue;
      }

      let predicted = ours; // what OpenRocket's mass model should say about our solid
      if (part.kind === "finset") predicted = openRocketFinVolume(part, model, ours);
      assert.ok(Math.abs(refVolume / predicted - 1) < 1e-7, `${part.name}: OpenRocket ${refVolume}, expected ${predicted}`);
    }
  });

  test(`${rocket}: OpenRocket's OBJ export lies on our parts`, async (t) => {
    const model = await loadOrkFile(fixture(`${rocket}.ork`));
    const ref = await readReference(rocket);
    const obj = await readObj(rocket);
    const byId = new Map(ref.components.map((c) => [c.id, c]));
    for (const part of allParts(model)) {
      const built = buildPart(asOpenRocket(part), model);
      if (!built) continue;
      const group = Number.parseInt(byId.get(part.id)!.objGroup!, 10);
      const indices = obj.groups.get(group);
      assert.ok(indices?.length, `${part.name}: no OBJ group ${group}`);
      const query = new DistanceQuery(makeCompound(built.solids.flatMap((s) => s.faces)));
      const distance = (p: [number, number, number]) => {
        const v = makeVertex(p);
        const d = query.distanceTo(v);
        v.delete();
        return d;
      };

      if (part.kind !== "transition") {
        let max = 0;
        for (const i of indices) max = Math.max(max, distance(obj.vertices[i]));
        t.diagnostic(`${part.name}: ${indices.length} OBJ vertices, max distance ${max.toExponential(2)} mm`);
        assert.ok(max < ON_SURFACE, `${part.name}: an OBJ vertex is ${max} mm from our part`);
        continue;
      }

      const stats = { outer: 0, outerMax: 0, inside: 0, insideMax: 0, leftOut: 0 };
      for (const i of indices) {
        const p = obj.vertices[i];
        const where = classify(part, model, p);
        assert.ok(where !== "outside", `${part.name}: OBJ vertex ${p.join(", ")} is outside our part`);
        if (where === "left-out shoulder") {
          stats.leftOut++;
          continue;
        }
        const d = distance(p);
        if (where === "outer") {
          stats.outer++;
          stats.outerMax = Math.max(stats.outerMax, d);
        } else {
          stats.inside++;
          stats.insideMax = Math.max(stats.insideMax, d);
        }
      }
      t.diagnostic(
        `${part.name}: ${stats.outer} outside-surface vertices, max distance ${stats.outerMax.toExponential(2)} mm; ` +
          `${stats.inside} inside vertices, up to ${stats.insideMax.toFixed(4)} mm from ours` +
          (stats.leftOut ? `; ${stats.leftOut} on zero-thickness shoulders we leave out` : ""),
      );
      assert.ok(stats.outer > 0, `${part.name}: no outside-surface vertices found`);
      assert.ok(stats.outerMax < ON_SURFACE, `${part.name}: outside surface off by ${stats.outerMax} mm`);
    }
  });
}

/**
 * OpenRocket's volume for our fins: the fin (without its tab) times the edge factor for its cross
 * section, plus the tab. We build the edges square. OpenRocket also stores an elliptical fin as 31
 * points on the ellipse joined by straight lines, which has sin(d)/d of the ellipse's area.
 */
function openRocketFinVolume(part: FinSetPart, model: RocketModel, ours: number): number {
  const finOnly = total(buildPart({ ...part, tab: null }, model)!.solids);
  const d = Math.PI / 30;
  const polygon = part.outline.shape === "elliptical" ? Math.sin(d) / d : 1;
  return finOnly * polygon * (EDGE_FACTOR[part.crossSection] ?? 1) + (ours - finOnly);
}

/**
 * Where an OBJ vertex of a nose cone or transition sits, using OpenRocket's own radius formula:
 * on the outside surface (must match us exactly), inside the part (OpenRocket's OBJ walls differ
 * on purpose), on a zero-thickness shoulder (which we leave out), or outside it (always wrong).
 */
function classify(
  part: TransitionPart,
  model: RocketModel,
  [x, y, z]: [number, number, number],
): "outer" | "inside" | "left-out shoulder" | "outside" {
  const tol = ON_SURFACE;
  const s = model.length - z - part.instances[0].x;
  const rho = Math.hypot(x, y);
  const L = part.length;
  const shoulder = (sh: TransitionPart["foreShoulder"], depth: number) => {
    if (sh.thickness <= 0 && !part.filled) return "left-out shoulder" as const;
    if (rho > sh.radius + tol) return "outside" as const;
    return rho >= sh.radius - tol || depth >= sh.length - tol ? ("outer" as const) : ("inside" as const);
  };
  if (s < -tol) return shoulder(part.foreShoulder, -s);
  if (s > L + tol) return shoulder(part.aftShoulder, s - L);
  const rOut = transitionRadius(part, Math.min(Math.max(s, 0), L));
  if (rho > rOut + tol) return "outside";
  if (rho >= rOut - tol) return "outer";
  // The flat ring where a shoulder meets the body is outside surface too.
  const ring = Math.abs(s) <= tol ? part.foreShoulder : Math.abs(s - L) <= tol ? part.aftShoulder : undefined;
  if (ring && ring.length > 0 && ring.thickness > 0 && rho >= ring.radius - tol) return "outer";
  return "inside";
}

