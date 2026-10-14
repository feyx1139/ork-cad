// Pockets, nut traps and edge shaping (chamfers, rounds), as solids to cut out of a part, after
// checking they fit.

import {
  basicFaceExtrusion,
  drawCircle,
  drawPolysides,
  drawRectangle,
  drawRoundedRectangle,
  makeSphere,
  revolution,
  Vector,
  type Drawing,
  type Edge,
  type Shape3D,
} from "replicad";
import type { Instance, Part, RocketModel } from "../ork/model.ts";
import { frameFor, type P2 } from "../geometry/frame.ts";
import { profileFace, revolveSection, type Curve } from "../geometry/section.ts";
import { FeatureError, type Chamfer, type NutTrap, type Pocket, type Round } from "./parse.ts";
import { endFace, hasShoulder, isSolid, outerRadiusAt, partSpan, type EndFace } from "./part-shape.ts";

/** How far (mm) the cutting tools reach past the part, so they always cut clean through. */
const MARGIN = 1;
/** Thinnest wall (mm) left around a pocket or nut. */
const MIN_WALL = 0.8;
const DEG = 180 / Math.PI;

/** The pocket (its mouth is rounded afterwards, by roundMouth). */
export function pocketTool(part: Part, model: RocketModel, inst: Instance, f: Pocket): Shape3D {
  needSolid(part, "Pockets");
  const face = endFace(part, f.end);
  const [s0, s1] = inward(face, 0, f.depth);
  checkWithin(part, s0, s1, "the pocket is deeper than the part");
  const reach = pocketReach(f);
  const wall = minOuter(part, s0, s1) - reach;
  if (wall < MIN_WALL) {
    throw new FeatureError(`the pocket reaches ${fmt(reach)} mm from the axis, leaving ${fmt(wall)} mm of wall (${MIN_WALL} mm needed)`);
  }
  if (f.round > 0) {
    if (f.round >= f.depth) throw new FeatureError("the rounded mouth is deeper than the pocket");
    // The rounding widens the opening by `round` all round, so at the end face it reaches furthest.
    const rim = face.radius - (reach + f.round);
    if (rim < MIN_WALL) {
      throw new FeatureError(
        `with its ${fmt(f.round)} mm rounded mouth the pocket reaches ${fmt(reach + f.round)} mm from the axis at the ${f.end} end, ` +
          `leaving ${fmt(rim)} mm there (${MIN_WALL} mm needed)`,
      );
    }
  }
  const drawing =
    f.shape.kind === "round"
      ? drawCircle(f.shape.diameter / 2)
      : f.shape.corner > 0
        ? drawRoundedRectangle(f.shape.width, f.shape.height, f.shape.corner)
        : drawRectangle(f.shape.width, f.shape.height);
  // From just outside the end face to the bottom of the pocket.
  const [t0, t1] = inward(face, -MARGIN, f.depth);
  return extrudeBetween(drawing.rotate((inst.angle + f.angle) * DEG, [0, 0]), model, inst, t0, t1);
}

/** How far the pocket's outline reaches from the axis. */
function pocketReach(f: Pocket): number {
  if (f.shape.kind === "round") return f.shape.diameter / 2;
  const { width, height, corner } = f.shape;
  return Math.hypot(width / 2 - corner, height / 2 - corner) + corner;
}

/**
 * Rounds the edge of a pocket's mouth once the pocket is cut, as a CAD fillet of the edges around
 * the opening (Onshape's Fillet does the same): along a straight wall the round is a cylinder,
 * around a rounded corner a torus, and at a sharp corner the rounds of the two walls run into each
 * other and meet in a crease along the diagonal.
 */
export function roundMouth(solid: Shape3D, part: Part, model: RocketModel, inst: Instance, f: Pocket, warnings: string[]): Shape3D {
  const face = endFace(part, f.end);
  const z = zAt(model, inst, face.s);
  const reach = pocketReach(f) + 1e-3;
  // The edges of the opening: in the end face and no further from the axis than the pocket goes.
  const mouth = (e: Edge) => {
    try {
      const points = [e.startPoint, e.endPoint, e.pointAt(0.5)];
      return points.every((p) => Math.abs(p.z - z) < 1e-4 && Math.hypot(p.x - inst.y, p.y - inst.z) <= reach) ? f.round : null;
    } catch {
      return null; // a degenerate edge (on the axis)
    }
  };
  try {
    return solid.fillet(mouth);
  } catch {
    // OpenCASCADE couldn't fillet it: flare the opening by the same round instead, which differs
    // only at sharp corners (rounded there rather than creased).
    warnings.push(`${part.name}: "${f.source}": the mouth's sharp corners are rounded off rather than creased.`);
    return mouthPieces(model, inst, f, face).reduce((s, p) => s.cut(p), solid);
  }
}

/**
 * What a pocket's rounded mouth takes away, built directly: the pocket's edge at the end face
 * rounded with radius `round` all the way round, as if every point of the opening were pushed out
 * by the round's profile. Along each straight wall that's the profile carried straight along;
 * around each corner it's the profile turned about the corner's centre (for a sharp corner, about
 * the corner itself), so the surfaces are exact cylinders and tori. Cut one piece at a time.
 */
export function mouthPieces(model: RocketModel, inst: Instance, f: Pocket, face: EndFace): Shape3D[] {
  const rho = f.round;
  const zFace = zAt(model, inst, face.s);
  const into = face.inward === 1 ? -1 : 1; // Z goes down the rocket, into a fore end
  const a = inst.angle + f.angle;
  const [cos, sin] = [Math.cos(a), Math.sin(a)];
  /** A point of the pocket's own plan (x along its width, y along its height), d into the part. */
  const place = (x: number, y: number, d: number): [number, number, number] => [
    inst.y + x * cos - y * sin,
    inst.z + x * sin + y * cos,
    zFace + into * d,
  ];
  /**
   * The cross-section that comes out, with u measured outward (the wall at u0) and d into the part:
   * the corner between the wall and the end face, cut by a quarter circle, plus margins inside the
   * pocket (down to u = inner) and outside the end face, so the cut is clean.
   */
  const profile = (u0: number, inner: number): Curve[] => {
    const k = rho * (1 - Math.SQRT1_2);
    return [
      { kind: "line", a: [inner, rho], b: [u0, rho] },
      { kind: "arc", a: [u0, rho], m: [u0 + k, k], b: [u0 + rho, 0] },
      { kind: "line", a: [u0 + rho, 0], b: [u0 + rho, -MARGIN] },
      { kind: "line", a: [u0 + rho, -MARGIN], b: [inner, -MARGIN] },
      { kind: "line", a: [inner, -MARGIN], b: [inner, rho] },
    ];
  };
  const overlap = 0.5; // how far the pieces reach into the (already cut) pocket
  const turned = (cx: number, cy: number, start: number, u0: number, sweep: number) => {
    const [c, s] = [Math.cos(start), Math.sin(start)];
    const section = profileFace(profile(u0, Math.max(0, u0 - overlap)), ([u, d]) => place(cx + u * c, cy + u * s, d));
    const [ax, ay] = place(cx, cy, 0);
    return revolution(section, [ax, ay, 0], [0, 0, 1], sweep);
  };
  if (f.shape.kind === "round") return [turned(0, 0, 0, f.shape.diameter / 2, 360)];

  const { width, height, corner } = f.shape;
  const [w, h] = [width / 2 - corner, height / 2 - corner]; // corner centres
  const pieces: Shape3D[] = [];
  // Straight walls: [wall point at the start, outward direction, direction along the wall, length].
  const walls: [[number, number], [number, number], [number, number], number][] = [
    [[width / 2, -h], [1, 0], [0, 1], 2 * h],
    [[-width / 2, -h], [-1, 0], [0, 1], 2 * h],
    [[-w, height / 2], [0, 1], [1, 0], 2 * w],
    [[-w, -height / 2], [0, -1], [1, 0], 2 * w],
  ];
  for (const [[px, py], [nx, ny], [tx, ty], length] of walls) {
    if (length < 1e-6) continue;
    const section = profileFace(profile(0, -overlap), ([u, d]) => place(px + u * nx, py + u * ny, d));
    const [ex, ey] = [tx * cos - ty * sin, tx * sin + ty * cos];
    pieces.push(basicFaceExtrusion(section, new Vector([ex * length, ey * length, 0])));
  }
  // Corners, each a quarter turn starting from the wall before it (counterclockwise).
  for (const [sx, sy, start] of [
    [1, 1, 0],
    [-1, 1, 90],
    [-1, -1, 180],
    [1, -1, 270],
  ] as const) {
    pieces.push(turned(sx * w, sy * h, (start * Math.PI) / 180, corner, 90));
  }
  return pieces;
}

export function nutTrapTools(part: Part, model: RocketModel, inst: Instance, f: NutTrap, warnings: string[]): Shape3D[] {
  needSolid(part, "Nut traps");
  if (f.bolt < f.depth + f.thickness) throw new FeatureError("the screw hole has to go past the nut (bolt at least depth + nut thickness)");
  const face = endFace(part, f.end);
  const [n0, n1] = inward(face, f.depth, f.depth + f.thickness);
  const [b0, b1] = inward(face, 0, f.bolt + f.hole / 2);
  checkWithin(part, b0, b1, "the screw hole is deeper than the part");
  const corner = f.flats / Math.sqrt(3); // the nut pocket's corners, from the axis
  const radius = minOuter(part, n0, n1);
  if (radius - corner < MIN_WALL) {
    throw new FeatureError(`the nut pocket reaches ${fmt(corner)} mm from the axis but the part is only ${fmt(radius)} mm in radius there`);
  }
  if (f.depth < 2) warnings.push(`${part.name}: only ${fmt(f.depth)} mm of plastic between the nut and the end, so it may pull through.`);
  if (!slotCovered(part, n0, n1)) {
    warnings.push(`${part.name}: the slot for the nut opens on the outside of the rocket, so the nut could fall out; tape over it.`);
  }

  // A hex with two flats along the slot, so the nut slides in (drawPolysides puts a corner on +Y).
  const a = (inst.angle + f.angle) * DEG;
  const reach = maxOuter(part, n0, n1) + MARGIN;
  const hex = drawPolysides(corner, 6).rotate(a - 90, [0, 0]);
  const slot = drawRectangle(reach, f.flats).translate(reach / 2, 0).rotate(a, [0, 0]);
  const nut = extrudeBetween(hex.fuse(slot), model, inst, n0, n1);
  // The screw hole, from just outside the end face, with a rounded end.
  const [h0, h1] = inward(face, -MARGIN, f.bolt);
  const hole = extrudeBetween(drawCircle(f.hole / 2), model, inst, h0, h1);
  const tip = makeSphere(f.hole / 2).translate(inst.y, inst.z, zAt(model, inst, face.s + face.inward * f.bolt));
  return [nut, hole, tip];
}

/** A round or chamfer on the outside edge of an end face, as a revolved cutting tool. */
export function edgeTool(part: Part, model: RocketModel, inst: Instance, f: Chamfer | Round): Shape3D {
  const face = endFace(part, f.end);
  const verb = f.kind === "round" ? "rounded" : "chamfered";
  if (face.straight <= 0) throw new FeatureError(`the ${f.end} end isn't a straight tube or shoulder, so its edge can't be ${verb} yet`);
  const R = face.radius;
  const se = face.s;
  const k = face.inward;
  const out = se - k * MARGIN; // just outside the end face
  let curves: Curve[];
  let rEnd: number; // where the cut meets the end face
  if (f.kind === "round") {
    const rho = f.radius;
    if (rho > face.straight) throw new FeatureError(`a ${fmt(rho)} mm round is longer than the ${fmt(face.straight)} mm straight section`);
    const c: P2 = [se + k * rho, R - rho];
    const onSide: P2 = [se + k * rho, R];
    rEnd = R - rho;
    const mid: P2 = [c[0] - k * rho * Math.SQRT1_2, c[1] + rho * Math.SQRT1_2];
    curves = [{ kind: "arc", a: onSide, m: mid, b: [se, rEnd] }, ...outsideOf([se, rEnd], out, R, onSide)];
  } else {
    const { length, angle, round: rho } = f;
    if (length > face.straight) {
      throw new FeatureError(`the chamfer runs ${fmt(length)} mm along the part, more than the ${fmt(face.straight)} mm straight section`);
    }
    if (rho * Math.sin(angle) > length) throw new FeatureError("the round at the start of the chamfer is too big for its length");
    // Starts on the side `length` from the end, optionally curving in with radius `round`, then
    // runs straight to the end face at `angle` from the axis.
    const onSide: P2 = [se + k * length, R];
    const bend: P2 = [onSide[0] - k * rho * Math.sin(angle), R - rho * (1 - Math.cos(angle))];
    rEnd = bend[1] - Math.abs(bend[0] - se) * Math.tan(angle);
    curves = [];
    if (rho > 0) {
      const mid: P2 = [onSide[0] - k * rho * Math.sin(angle / 2), R - rho + rho * Math.cos(angle / 2)];
      curves.push({ kind: "arc", a: onSide, m: mid, b: bend });
    }
    curves.push({ kind: "line", a: bend, b: [se, rEnd] }, ...outsideOf([se, rEnd], out, R, onSide));
  }
  if (rEnd < face.innerRadius + 0.4 || rEnd <= 0) {
    throw new FeatureError(`the ${f.kind} would cut ${fmt(R - rEnd)} mm in from the outside, through the end of the part`);
  }
  return revolveSection(curves, frameFor(model, inst));
}

/** Closes a cutting profile around the outside of the corner being removed. */
function outsideOf(onFace: P2, out: number, R: number, onSide: P2): Curve[] {
  const pts: P2[] = [onFace, [out, onFace[1]], [out, R + MARGIN], [onSide[0], R + MARGIN], onSide];
  return pts.slice(0, -1).map((a, i) => ({ kind: "line" as const, a, b: pts[i + 1] }));
}

function needSolid(part: Part, what: string): void {
  if (!isSolid(part)) {
    throw new FeatureError(
      `${what} need a solid part: tick "Filled" for it in OpenRocket, and set its material to your infill density so the mass stays right`,
    );
  }
}

/** The axial range reached going from `from` to `to` mm into the part from an end face. */
function inward(face: EndFace, from: number, to: number): [number, number] {
  const a = face.s + face.inward * from;
  const b = face.s + face.inward * to;
  return a < b ? [a, b] : [b, a];
}

function checkWithin(part: Part, s0: number, s1: number, message: string): void {
  const span = partSpan(part);
  if (s0 < span.min - 1e-9 || s1 > span.max + 1e-9) throw new FeatureError(`${message} (${fmt(span.max - span.min)} mm long)`);
}

/** Whether the side of the part at this axial range is inside another tube once assembled. */
function slotCovered(part: Part, s0: number, s1: number): boolean {
  if (part.kind === "transition") {
    return (hasShoulder(part, "fore") && s1 <= 0) || (hasShoulder(part, "aft") && s0 >= part.length);
  }
  return part.kind === "cylinder" && part.type !== "bodytube";
}

function sampleOuter(part: Part, s0: number, s1: number): number[] {
  return Array.from({ length: 41 }, (_, i) => outerRadiusAt(part, s0 + ((s1 - s0) * i) / 40));
}

function minOuter(part: Part, s0: number, s1: number): number {
  return Math.min(...sampleOuter(part, s0, s1));
}

function maxOuter(part: Part, s0: number, s1: number): number {
  return Math.max(...sampleOuter(part, s0, s1));
}

function zAt(model: RocketModel, inst: Instance, s: number): number {
  return model.length - inst.x - s;
}

/** Extrudes a drawing (centred on the part's axis, in the XY plane) over an axial range. */
function extrudeBetween(drawing: Drawing, model: RocketModel, inst: Instance, s0: number, s1: number): Shape3D {
  const za = zAt(model, inst, s0);
  const zb = zAt(model, inst, s1);
  const lo = Math.min(za, zb);
  return drawing.translate(inst.y, inst.z).sketchOnPlane("XY", lo).extrude(Math.abs(za - zb)) as Shape3D;
}

function fmt(v: number): string {
  return String(Number(v.toFixed(2)));
}
