// Cross-sections in (s, r) — s along a part's axis from its fore end, r the distance from the
// axis — made of exact curves and revolved into solids in the CAD frame of frame.ts.

import {
  assembleWire,
  Edge,
  getOC,
  makeBSplineApproximation,
  makeEllipseArc,
  makeFace,
  makeLine,
  revolution,
  type Face,
  type Shape3D,
} from "replicad";
import { at3, type Frame, type P2 } from "./frame.ts";

/** One edge of a cross-section, described exactly. */
export type Curve =
  | { kind: "line"; a: P2; b: P2 }
  /** Ellipse arc: s = cs - dir * axial * cos(t), r = cr + radial * sin(t), t from t0 to t1. */
  | { kind: "ellipse"; cs: number; cr: number; axial: number; radial: number; dir: 1 | -1; t0: number; t1: number }
  | { kind: "arc"; a: P2; m: P2; b: P2 }
  | { kind: "spline"; points: P2[] };

export const SPLINE_TOLERANCE = 1e-5; // mm

export function edgeOf(c: Curve, f: Frame): Edge {
  switch (c.kind) {
    case "line":
      return makeLine(at3(f, c.a), at3(f, c.b));
    case "arc":
      return arcEdge(at3(f, c.a), at3(f, c.m), at3(f, c.b));
    case "spline":
      return makeBSplineApproximation(
        c.points.map((p) => at3(f, p)),
        { tolerance: SPLINE_TOLERANCE, degMin: 3, degMax: 8 },
      );
    case "ellipse": {
      const center = at3(f, [c.cs, c.cr]);
      const [t0, t1] = c.t0 < c.t1 ? [c.t0, c.t1] : [c.t1, c.t0];
      // OpenCASCADE wants the major radius first, so orient the ellipse by its longer axis.
      if (c.axial >= c.radial) {
        return makeEllipseArc(c.axial, c.radial, t0, t1, center, [0, c.dir, 0], [0, 0, c.dir]);
      }
      return makeEllipseArc(c.radial, c.axial, Math.PI / 2 - t1, Math.PI / 2 - t0, center, [0, -c.dir, 0], [1, 0, 0]);
    }
  }
}

/**
 * A circular arc through three points, as the exact rational B-spline of that arc. An ogive's arc
 * has its centre far across the axis, and OpenCASCADE's own STEP reader turns such a revolved
 * circle into a broken solid; the B-spline form is the same shape and reads back intact.
 */
function arcEdge(a: [number, number, number], m: [number, number, number], b: [number, number, number]): Edge {
  const oc = getOC();
  const pnt = (p: [number, number, number]) => new oc.gp_Pnt(p[0], p[1], p[2]);
  const [pa, pm, pb] = [pnt(a), pnt(m), pnt(b)];
  const maker = new oc.GC_MakeArcOfCircle(pa, pm, pb);
  const spline = oc.GeomConvert.CurveToBSplineCurve(maker.Value(), oc.Convert_ParameterisationType.Convert_TgtThetaOver2);
  const edgeMaker = new oc.BRepBuilderAPI_MakeEdge(spline);
  const edge = new Edge(edgeMaker.Edge());
  for (const o of [pa, pm, pb, maker, edgeMaker]) o.delete();
  return edge;
}

export function curveStart(c: Curve): P2 {
  switch (c.kind) {
    case "line":
    case "arc":
      return c.a;
    case "spline":
      return c.points[0];
    case "ellipse":
      return ellipsePoint(c, c.t0);
  }
}

export function curveEnd(c: Curve): P2 {
  switch (c.kind) {
    case "line":
    case "arc":
      return c.b;
    case "spline":
      return c.points[c.points.length - 1];
    case "ellipse":
      return ellipsePoint(c, c.t1);
  }
}

export function ellipsePoint(c: Extract<Curve, { kind: "ellipse" }>, t: number): P2 {
  return [c.cs - c.dir * c.axial * Math.cos(t), c.cr + c.radial * Math.sin(t)];
}

export function reverseCurve(c: Curve): Curve {
  switch (c.kind) {
    case "line":
      return { kind: "line", a: c.b, b: c.a };
    case "arc":
      return { kind: "arc", a: c.b, m: c.m, b: c.a };
    case "spline":
      return { kind: "spline", points: [...c.points].reverse() };
    case "ellipse":
      return { ...c, t0: c.t1, t1: c.t0 };
  }
}

/** Shorter than this (mm) is a point; OpenCASCADE treats anything under 1e-7 mm as one. */
export const EPS = 1e-7;
/** Points this close (mm) to an end face or the axis are moved exactly onto it. */
export const SNAP = 1e-6;

/** Revolves a closed cross-section (a chain of curves) around the frame's axis. */
export function revolveSection(curves: Curve[], f: Frame): Shape3D {
  const edges: Edge[] = [];
  let first: P2 | undefined;
  let last: P2 | undefined;
  for (const c of curves) {
    const a = curveStart(c);
    const b = curveEnd(c);
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < EPS) continue; // skip degenerate pieces
    edges.push(edgeOf(c, f));
    first ??= a;
    last = b;
  }
  if (!first || !last || Math.hypot(first[0] - last[0], first[1] - last[1]) > 1e-6) {
    throw new Error("Internal error: cross-section isn't closed.");
  }
  return revolution(makeFace(assembleWire(edges)), [f.cx, f.cy, 0], [0, 0, 1]);
}

/** A closed profile of lines and arcs as a flat face, with `place` putting each of its points in 3D. */
export function profileFace(curves: Curve[], place: (p: P2) => [number, number, number]): Face {
  const edges: Edge[] = [];
  for (const c of curves) {
    if (c.kind !== "line" && c.kind !== "arc") throw new Error(`Internal error: a ${c.kind} in a profile.`);
    if (Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]) < EPS) continue;
    edges.push(c.kind === "line" ? makeLine(place(c.a), place(c.b)) : arcEdge(place(c.a), place(c.m), place(c.b)));
  }
  return makeFace(assembleWire(edges));
}

/** A closed polygon as line curves. */
export function polygon(points: P2[]): Curve[] {
  return points.map((a, i) => ({ kind: "line" as const, a, b: points[(i + 1) % points.length] }));
}
