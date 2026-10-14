// Builds exact CAD solids (OpenCASCADE B-rep, via replicad) for each part of a rocket model, in
// the CAD frame of frame.ts. Every part is placed where it sits in the rocket, so importing all of
// them into one CAD model (or Onshape assembly) puts them together.
//
// Round parts are drawn as a cross-section in (s, r) — s along the axis from the part's fore end,
// r the radius — and revolved. Outer surfaces use exact curves where OpenRocket's shape allows it
// (line, ellipse arc, circular arc); other shapes and the inside of curved walls are B-splines fitted
// to the exact formula within 0.00001 mm. Wall thickness is measured perpendicular to the surface,
// as in OpenRocket's mass model.

import {
  assembleWire,
  basicFaceExtrusion,
  makeCylinder,
  makeEllipseArc,
  makeFace,
  makeLine,
  revolution,
  Vector,
  type Edge,
  type Shape3D,
} from "replicad";
import {
  UnsupportedError,
  type CylinderPart,
  type FinSetPart,
  type Instance,
  type Part,
  type RailButtonPart,
  type RocketModel,
  type Shoulder,
  type TransitionPart,
} from "../ork/model.ts";
import { clipLength, isClipped, transitionRadius } from "./shapes.ts";
import { frameFor, type Frame, type P2 } from "./frame.ts";
import { curveEnd, curveStart, ellipsePoint, EPS, polygon, reverseCurve, revolveSection, SNAP, type Curve } from "./section.ts";
import { cutFeatures } from "../features/apply.ts";

export interface BuiltPart {
  part: Part;
  /** One solid per instance, in the CAD frame. */
  solids: Shape3D[];
  warnings: string[];
}

/**
 * Builds a part's solids, or returns null for parts without geometry (mass components,
 * parachutes...). Throws UnsupportedError for parts the tool can't build yet.
 */
export function buildPart(part: Part, model: RocketModel): BuiltPart | null {
  const warnings: string[] = [];
  let solids: Shape3D[];
  switch (part.kind) {
    case "unsupported":
      throw new UnsupportedError(part.reason);
    case "transition":
      solids = part.instances.map((inst) => buildTransition(part, frameFor(model, inst), warnings));
      break;
    case "cylinder":
      solids = part.instances.map((inst) => buildCylinder(part, frameFor(model, inst)));
      break;
    case "finset":
      solids = part.instances.map((inst) => buildFin(part, model, inst, warnings));
      break;
    case "railbutton":
      solids = part.instances.map((inst) => buildRailButton(part, model, inst));
      break;
    default:
      return null;
  }
  // Details from the component's comment (holes...), cut into each copy.
  solids = solids.map((solid, i) => cutFeatures(part, model, part.instances[i], solid, warnings));
  return { part, solids, warnings: [...new Set(warnings)] };
}

// ---------------------------------------------------------------------------------------------
// Cylinders: body tubes, inner tubes, couplers, rings, bulkheads, launch lugs

function buildCylinder(p: CylinderPart, f: Frame): Shape3D {
  const L = p.length;
  return revolveSection(
    polygon([
      [0, p.innerRadius],
      [L, p.innerRadius],
      [L, p.outerRadius],
      [0, p.outerRadius],
    ]),
    f,
  );
}

// ---------------------------------------------------------------------------------------------
// Nose cones and transitions

/** The outer profile: an exact edge plus a smooth parametrisation u in [0, 1] from fore to aft end. */
interface Outer {
  curve: Curve;
  at(u: number): P2;
  /** The inside surface of a wall, if it has an exact form (offsets of lines and circles do). */
  exactOffset?: "line" | "arc";
}

function outerProfile(t: TransitionPart): Outer {
  const L = t.length;
  const r1 = t.foreRadius;
  const r2 = t.aftRadius;
  const line = (): Outer => {
    const a: P2 = [0, r1];
    const b: P2 = [L, r2];
    return { curve: { kind: "line", a, b }, at: (u) => [u * L, r1 + u * (r2 - r1)], exactOffset: "line" };
  };
  if (r1 === r2) return line();
  // Same special cases as OpenRocket's exporter: these parameter values are straight cones.
  if (
    t.shape === "conical" ||
    (t.shape === "ogive" && t.shapeParameter < 0.001) ||
    (t.shape === "power" && t.shapeParameter === 1) ||
    (t.shape === "parabolic" && t.shapeParameter === 0)
  ) {
    return line();
  }
  // "Narrow end" is where the nose shape's tip would be; dir = +1 when it is the fore end.
  const dir: 1 | -1 = r1 < r2 ? 1 : -1;
  const rNarrow = Math.min(r1, r2);
  const rWide = Math.max(r1, r2);
  const clipped = isClipped(t);

  if (t.shape === "ellipsoid") {
    // r = rNarrow + ellipse, or (clipped) part of a bigger ellipse centred on the axis.
    const clip = clipped ? clipLength(t) : 0;
    const axial = L + clip;
    const radial = clipped ? rWide : rWide - rNarrow;
    const cr = clipped ? 0 : rNarrow;
    const cs = dir === 1 ? L : 0; // centre at the wide end
    const tNarrow = clipped ? Math.acos(L / axial) : 0;
    const e = { kind: "ellipse" as const, cs, cr, axial, radial, dir, t0: 0, t1: 0 };
    // Orient from the fore end (u = 0) to the aft end (u = 1).
    const [ta, tb] = dir === 1 ? [tNarrow, Math.PI / 2] : [Math.PI / 2, tNarrow];
    const curve = { ...e, t0: ta, t1: tb };
    return { curve, at: (u) => ellipsePoint(curve, ta + u * (tb - ta)) };
  }

  if (t.shape === "ogive" && !clipped && L >= rWide - rNarrow) {
    // An ogive is a circular arc (when OpenRocket doesn't have to rescale it).
    const at = (u: number): P2 => [u * L, transitionRadius(t, u * L)];
    return { curve: { kind: "arc", a: at(0), m: at(0.5), b: at(1) }, at, exactOffset: "arc" };
  }

  // Power series, parabolic series, Haack series, rescaled ogives: fit a B-spline to the formula.
  // Points cluster at the narrow end, where these shapes are steepest.
  const p = t.shape === "power" && t.shapeParameter < 0.5 ? 1 / Math.max(t.shapeParameter, 0.05) : 2;
  const sAt = (u: number) => (dir === 1 ? L * Math.pow(u, p) : L * (1 - Math.pow(1 - u, p)));
  const at = (u: number): P2 => {
    const s = sAt(u);
    return [s, transitionRadius(t, s)];
  };
  const points = Array.from({ length: 401 }, (_, i) => at(i / 400));
  return { curve: { kind: "spline", points }, at };
}

/** Outward unit normal of the outer profile at u (pointing away from the solid). */
function outwardNormal(o: Outer, u: number): P2 {
  const h = 1e-6;
  const ua = Math.max(0, u - h);
  const ub = Math.min(1, u + h);
  const a = o.at(ua);
  const b = o.at(ub);
  const ds = b[0] - a[0];
  const dr = b[1] - a[1];
  const n = Math.hypot(ds, dr);
  return [-dr / n, ds / n];
}

interface Inner {
  curves: Curve[];
  start: P2;
  end: P2;
}

/**
 * The inside surface of a wall of thickness w: the outer profile offset perpendicular to itself,
 * trimmed to the part (0 <= s <= L) and to the axis (r >= 0), extended straight to the ends where
 * the offset falls short of them. Returns null if no inside is left (the wall fills the part).
 */
function innerProfile(o: Outer, L: number, w: number, warnings: string[], name: string): Inner | null {
  const q = (u: number): P2 => {
    const p = o.at(u);
    const n = outwardNormal(o, u);
    return [p[0] - w * n[0], p[1] - w * n[1]];
  };
  const N = 400;
  let us = Array.from({ length: N + 1 }, (_, i) => i / N);
  let pts = us.map(q);

  // Where the wall is thicker than the profile's radius of curvature (sharp narrow ends), the
  // offset runs backward and folds over. Start and end it where it turns forward again.
  let i0 = 0;
  while (i0 + 1 < pts.length && pts[i0 + 1][0] <= pts[i0][0]) i0++;
  let i1 = pts.length - 1;
  while (i1 - 1 > i0 && pts[i1 - 1][0] >= pts[i1][0]) i1--;
  if (i0 > 0 || i1 < pts.length - 1) {
    warnings.push(`${name}: the wall is thicker than the shape's curvature at a narrow end; the inside is trimmed there.`);
  }
  pts = pts.slice(i0, i1 + 1);
  us = us.slice(i0, i1 + 1);
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] <= pts[i - 1][0]) throw new UnsupportedError(`${name}: the wall is too thick for this shape.`);
  }

  // Trim to r >= 0 and 0 <= s <= L, locating each crossing exactly by bisection on u. Points this
  // close to an end face or the axis are put exactly on it, so no hair-thin edges appear.
  const inside = (p: P2) => p[1] >= -SNAP && p[0] >= -SNAP && p[0] <= L + SNAP;
  const onPart = (p: P2) => p[1] >= 0 && p[0] >= 0 && p[0] <= L;
  const snap = (p: P2): P2 => [
    Math.abs(p[0]) < SNAP ? 0 : Math.abs(p[0] - L) < SNAP ? L : p[0],
    Math.abs(p[1]) < SNAP ? 0 : p[1],
  ];
  /** Where the offset enters the part between uOut (outside) and uIn, or undefined if uIn is already on its edge. */
  const crossing = (uOut: number, uIn: number): P2 | undefined => {
    let a = uOut;
    let b = uIn;
    if (!onPart(q(b))) return undefined;
    for (let k = 0; k < 80; k++) {
      const m = (a + b) / 2;
      if (onPart(q(m))) b = m;
      else a = m;
    }
    const p = q(b);
    return snap([Math.min(Math.max(p[0], 0), L), Math.max(p[1], 0)]);
  };
  const near = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < SNAP;
  const firstIn = pts.findIndex(inside);
  if (firstIn < 0) return null;
  let lastIn = pts.length - 1;
  while (!inside(pts[lastIn])) lastIn--;
  const trimmed: P2[] = pts.slice(firstIn, lastIn + 1).map(snap);
  const head0 = firstIn > 0 ? crossing(us[firstIn - 1], us[firstIn]) : undefined;
  if (head0 && !near(head0, trimmed[0])) trimmed.unshift(head0);
  const tail0 = lastIn < pts.length - 1 ? crossing(us[lastIn + 1], us[lastIn]) : undefined;
  if (tail0 && !near(tail0, trimmed[trimmed.length - 1])) trimmed.push(tail0);

  // Extend straight along the end tangents when the offset stops short of an end.
  const extend = (p: P2, toward: P2, sTarget: number): P2 | null => {
    const ds = p[0] - toward[0];
    const dr = p[1] - toward[1];
    if (Math.abs(ds) < 1e-15) return null;
    let k = (sTarget - p[0]) / ds;
    let r = p[1] + k * dr;
    if (r < 0) {
      k = -p[1] / dr;
      r = 0;
    }
    return snap([p[0] + k * ds, r]);
  };
  let start = trimmed[0];
  let end = trimmed[trimmed.length - 1];
  const head: Curve[] = [];
  const tail: Curve[] = [];
  const closesEnd = (e: P2, side: string) => {
    // A curved end meeting the end face square-on: the wall can't be offset to the face, so the
    // end closes up, the same way OpenRocket's mass model treats it.
    if (e[1] === 0) warnings.push(`${name}: the inside doesn't reach the ${side} end, so that end is built closed.`);
  };
  if (start[0] > 0 && start[1] > 0) {
    const e = extend(start, trimmed[1], 0);
    if (e) {
      if (o.at(0)[1] > 0) closesEnd(e, "fore");
      head.push({ kind: "line", a: e, b: start });
      start = e;
    }
  }
  if (end[0] < L && end[1] > 0) {
    const e = extend(end, trimmed[trimmed.length - 2], L);
    if (e) {
      if (o.at(1)[1] > 0) closesEnd(e, "aft");
      tail.push({ kind: "line", a: end, b: e });
      end = e;
    }
  }

  // The offset of a straight line is the same straight line all the way, extensions included.
  if (o.exactOffset === "line") return { curves: [{ kind: "line", a: start, b: end }], start, end };
  let main: Curve;
  const a = trimmed[0];
  const b = trimmed[trimmed.length - 1];
  if (o.exactOffset === "arc") {
    main = { kind: "arc", a, m: trimmed[Math.floor(trimmed.length / 2)], b };
  } else {
    main = { kind: "spline", points: trimmed };
  }
  const curves = [...head, main, ...tail].filter((c) => {
    const p0 = curveStart(c);
    const p1 = curveEnd(c);
    return Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) > EPS;
  });
  return { curves, start, end };
}

function buildTransition(t: TransitionPart, f: Frame, warnings: string[]): Shape3D {
  const L = t.length;
  const o = outerProfile(t);
  // End radii as the profile actually reaches them. They equal the fore/aft radius except for
  // clipped shapes, where OpenRocket's clip search stops within 0.1 mm.
  const r1 = curveStart(o.curve)[1];
  const r2 = curveEnd(o.curve)[1];
  const section: Curve[] = [];
  // Fore end: from the axis up to the start of the outer profile.
  const inner = t.filled || t.thickness <= 0 ? null : innerProfile(o, L, t.thickness, warnings, t.name);
  if (!t.filled && t.thickness <= 0) {
    warnings.push(`${t.name}: wall thickness is 0, so it is built solid.`);
  }
  if (!inner) {
    section.push({ kind: "line", a: [0, 0], b: [0, r1] });
    section.push(o.curve);
    section.push({ kind: "line", a: [L, r2], b: [L, 0] });
    section.push({ kind: "line", a: [L, 0], b: [0, 0] });
  } else {
    section.push(o.curve);
    // Aft end: down from the outer profile to the inside surface (or the axis).
    section.push({ kind: "line", a: [L, r2], b: [L, inner.end[1]] });
    if (inner.end[0] < L) {
      // The inside reached the axis before the aft end: the aft end is solid.
      section.push({ kind: "line", a: [L, 0], b: [inner.end[0], 0] });
    }
    for (const c of [...inner.curves].reverse()) section.push(reverseCurve(c));
    // Fore end: from the inside surface (or the axis) back to the outer profile.
    if (inner.start[0] > 0) {
      section.push({ kind: "line", a: [inner.start[0], 0], b: [0, 0] });
      section.push({ kind: "line", a: [0, 0], b: [0, r1] });
    } else {
      section.push({ kind: "line", a: [0, inner.start[1]], b: [0, r1] });
    }
  }
  let solid = revolveSection(section, f);

  const shoulders: [Shoulder, "fore" | "aft"][] = [
    [t.foreShoulder, "fore"],
    [t.aftShoulder, "aft"],
  ];
  for (const [sh, side] of shoulders) {
    const touches = side === "fore" ? r1 > 0 : r2 > 0;
    if (sh.length <= 0 || sh.radius <= 0 || !touches) continue;
    if (!t.filled && sh.thickness <= 0) {
      warnings.push(`${t.name}: ${side} shoulder has 0 mm walls, so it is left out (it can't be printed).`);
      continue;
    }
    const before = solid.solids.length;
    solid = solid.fuse(revolveSection(shoulderSection(sh, side, L, t.filled), f));
    if (solid.solids.length > before) {
      warnings.push(
        `${t.name}: the ${side} shoulder doesn't touch the wall (it's narrower than the inside of the ${side} end), so it's a separate piece.`,
      );
    }
  }
  return solid;
}

/** Cross-section of a shoulder: a tube, closed at its far end by a cap as thick as the wall. */
function shoulderSection(sh: Shoulder, side: "fore" | "aft", L: number, filled: boolean): Curve[] {
  // Work outward from the joint: d = distance from the transition's end, mapped to s below.
  const s = (d: number) => (side === "fore" ? -d : L + d);
  const R = sh.radius;
  const ri = filled ? 0 : Math.max(0, R - sh.thickness);
  const len = sh.length;
  if (filled || ri === 0) {
    return polygon([
      [s(0), 0],
      [s(len), 0],
      [s(len), R],
      [s(0), R],
    ]);
  }
  if (sh.capped) {
    const capInner = Math.max(0, len - sh.thickness);
    return polygon([
      [s(0), ri],
      [s(capInner), ri],
      [s(capInner), 0],
      [s(len), 0],
      [s(len), R],
      [s(0), R],
    ]);
  }
  return polygon([
    [s(0), ri],
    [s(len), ri],
    [s(len), R],
    [s(0), R],
  ]);
}

// ---------------------------------------------------------------------------------------------
// Fins

function buildFin(p: FinSetPart, model: RocketModel, inst: Instance, warnings: string[]): Shape3D {
  if (p.cant !== 0) throw new UnsupportedError(`"${p.name}" has canted fins, which aren't supported yet.`);
  if (p.crossSection !== "square") {
    warnings.push(`${p.name}: ${p.crossSection} fin edges are built square for now (as OpenRocket's own export does).`);
  }
  if (p.filletRadius > 0) {
    warnings.push(`${p.name}: root fillets aren't built yet.`);
  }
  if (Math.abs(p.tabMoved) >= 0.01) {
    const by = Number(Math.abs(p.tabMoved).toFixed(2));
    warnings.push(
      `${p.name}: OpenRocket opens this file with the fin tab ${by} mm further ${p.tabMoved < 0 ? "forward" : "back"} than its saved ` +
        `position (an OpenRocket bug with elliptical fins: it places the tab as if the fin were 50 mm long). ` +
        `The tab here is where OpenRocket shows and simulates it. Each time the file is opened and saved in OpenRocket the tab ` +
        `moves again; measuring the tab's position from the fin's front (top) in OpenRocket stops that.`,
    );
  }
  // Fin plane at angle 0: X = body radius + span coordinate, Z = fore end - chord coordinate.
  const ztop = model.length - inst.x;
  const R = p.bodyRadius;
  const pt = (fx: number, fy: number): [number, number, number] => [R + fy, 0, ztop - fx];
  const edges: Edge[] = [];
  const o = p.outline;
  if (o.shape === "elliptical") {
    const c = o.rootChord / 2;
    edges.push(makeLine(pt(o.rootChord, 0), pt(0, 0)));
    const center = pt(c, 0);
    edges.push(
      c >= o.height
        ? makeEllipseArc(c, o.height, 0, Math.PI, center, [0, 1, 0], [0, 0, 1])
        : makeEllipseArc(o.height, c, -Math.PI / 2, Math.PI / 2, center, [0, -1, 0], [1, 0, 0]),
    );
  } else {
    const pts: [number, number][] =
      o.shape === "trapezoid"
        ? [
            [0, 0],
            [o.sweep, o.height],
            [o.sweep + o.tipChord, o.height],
            [o.rootChord, 0],
          ]
        : o.points;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > EPS) edges.push(makeLine(pt(a[0], a[1]), pt(b[0], b[1])));
    }
  }
  const t = p.thickness;
  let fin: Shape3D = basicFaceExtrusion(makeFace(assembleWire(edges)).translate(0, -t / 2, 0), new Vector([0, t, 0]));
  if (p.tab) {
    const { start, length, height } = p.tab;
    const tab = [
      [start, 0],
      [start, -height],
      [start + length, -height],
      [start + length, 0],
    ].map(([fx, fy]) => pt(fx, fy));
    const tabEdges = tab.map((a, i) => makeLine(a, tab[(i + 1) % tab.length]));
    fin = fin.fuse(basicFaceExtrusion(makeFace(assembleWire(tabEdges)).translate(0, -t / 2, 0), new Vector([0, t, 0])));
  }
  return fin.rotate((inst.angle * 180) / Math.PI, [0, 0, 0], [0, 0, 1]);
}

// ---------------------------------------------------------------------------------------------
// Rail buttons

function buildRailButton(p: RailButtonPart, model: RocketModel, inst: Instance): Shape3D {
  // Built pointing along +X from the body surface, then turned to the button's angle.
  const R = Math.hypot(inst.y, inst.z);
  const zc = model.length - inst.x;
  const ro = p.outerDiameter / 2;
  const ri = p.innerDiameter / 2;
  const inner = p.height - p.baseHeight - p.flangeHeight;
  let b: Shape3D = makeCylinder(ro, p.baseHeight, [R, 0, zc], [1, 0, 0]);
  b = b.fuse(makeCylinder(ri, inner, [R + p.baseHeight, 0, zc], [1, 0, 0]));
  b = b.fuse(makeCylinder(ro, p.flangeHeight, [R + p.baseHeight + inner, 0, zc], [1, 0, 0]));
  if (p.screwHeight > 0) {
    // Screw head: half an ellipsoid on top of the flange, as in OpenRocket.
    const x0 = R + p.height;
    const sh = p.screwHeight;
    const head: Edge[] = [
      // Quarter ellipse from (x0, ro) to (x0 + sh, 0); OpenCASCADE wants the major radius first.
      ro >= sh
        ? makeEllipseArc(ro, sh, 0, Math.PI / 2, [x0, 0, zc], [0, 0, -1], [0, 1, 0])
        : makeEllipseArc(sh, ro, 0, Math.PI / 2, [x0, 0, zc], [0, 0, 1], [1, 0, 0]),
      makeLine([x0 + sh, 0, zc], [x0, 0, zc]),
      makeLine([x0, 0, zc], [x0, ro, zc]),
    ];
    b = b.fuse(revolution(makeFace(assembleWire(head)), [x0, 0, zc], [1, 0, 0]));
  }
  return b.rotate((inst.angle * 180) / Math.PI, [0, 0, 0], [0, 0, 1]);
}
