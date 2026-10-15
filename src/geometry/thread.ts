// Screw threads as exact solids: a trapezoidal thread with 45° flanks (prints standing up without
// supports), right-handed, around the Z axis.
//
// A thread is built as its ridge (tooth): a trapezoid in each plane through the axis, carried round
// a helix. Every edge along the thread is an exact helix (a straight line on a cylinder, in its
// own parameters), and every face between two of them is the ruled surface joining them, which
// is the exact thread surface: the profile's sides are straight lines in those planes. The ends of
// a tooth are flat, in a plane through the axis (the thread stops square). Unlike a sweep, these
// faces mesh to a handful of triangles per turn, and they cut cleanly against cylinders.
//
// The tooth is joined to a plain cylinder (a plug's core) or cut out of one (a collar's groove)
// along the cylinder's own surface, so booleans never have to cross the helical faces.

import { getOC, loft, makePolygon, makeSolid, Wire, type Face, type Shape3D, type Shell } from "replicad";

export interface ThreadProfile {
  /** Radius at the bottom of the grooves and at the top of the ridges, mm. */
  root: number;
  crest: number;
  pitch: number;
  /** Axial width of the flat top of each ridge, mm. */
  crestFlat: number;
}

/** Half the ridge's axial width at radius r (its flanks are at 45°). */
export function halfWidth(t: ThreadProfile, r: number): number {
  return t.crestFlat / 2 + (t.crest - r);
}

/**
 * The axial position of the middle of the ridge at angle θ (radians, from +X toward +Y), up to
 * whole pitches: right-handed, it climbs one pitch per turn. Screws made from the same profile fit
 * together, whatever their length.
 */
export function ridgeCentre(t: ThreadProfile, theta: number): number {
  return (t.pitch * theta) / (2 * Math.PI);
}

/**
 * The ridge of a thread, from radius `inner` (below the root, so it reaches into the core it's
 * joined to, or out of the collar it's cut from) up to the crest, where it lies wholly between
 * heights z0 and z1. Returns null if the span is too short for any of it.
 */
export function makeTooth(t: ThreadProfile, inner: number, z0: number, z1: number): Shape3D | null {
  const hw = halfWidth(t, inner);
  const c = t.crestFlat / 2;
  const turn = (z: number) => (2 * Math.PI * z) / t.pitch;
  const start = turn(z0 + hw);
  const end = turn(z1 - hw);
  if (end <= start) return null;
  // The trapezoid, in (radius, height above the ridge's middle), going round it.
  const corners: [number, number][] = [
    [inner, -hw],
    [t.crest, -c],
    [t.crest, c],
    [inner, hw],
  ];
  // Faces span at most half a turn each, which keeps them simple for meshing and booleans.
  const pieces = Math.max(1, Math.ceil((end - start) / Math.PI));
  const faces: (Face | Shell)[] = [];
  for (let k = 0; k < pieces; k++) {
    const a = start + ((end - start) * k) / pieces;
    const b = start + ((end - start) * (k + 1)) / pieces;
    const helices = corners.map(([r, dz]) => helix(r, a, b, ridgeCentre(t, a) + dz, t.pitch));
    for (let i = 0; i < 4; i++) faces.push(loft([helices[i], helices[(i + 1) % 4]], { ruled: true }, true) as Shell);
  }
  for (const theta of [start, end]) {
    const z = ridgeCentre(t, theta);
    faces.push(makePolygon(corners.map(([r, dz]) => [r * Math.cos(theta), r * Math.sin(theta), z + dz])));
  }
  return makeSolid(faces);
}

/** A helix on the cylinder of radius r around Z, from angle a (at height z) to angle b, climbing pitch per turn. */
function helix(r: number, a: number, b: number, z: number, pitch: number): Wire {
  const oc = getOC();
  const ax = new oc.gp_Ax3(new oc.gp_Pnt(0, 0, 0), new oc.gp_Dir(0, 0, 1), new oc.gp_Dir(1, 0, 0));
  const surface = new oc.Geom_CylindricalSurface(ax, r);
  // On the cylinder, (u, v) = (angle, height): a helix is a straight line.
  const p = new oc.gp_Pnt2d(a, z);
  const q = new oc.gp_Pnt2d(b, z + (pitch * (b - a)) / (2 * Math.PI));
  const segment = new oc.GC_MakeSegment2d(p, q);
  const maker = new oc.BRepBuilderAPI_MakeEdge(segment.Value(), surface);
  const wireMaker = new oc.BRepBuilderAPI_MakeWire(maker.Edge());
  const wire = wireMaker.Wire();
  oc.BRepLib.BuildCurves3d(wire);
  const result = new Wire(wire);
  for (const o of [ax, p, q, segment, maker, wireMaker]) o.delete();
  return result;
}
