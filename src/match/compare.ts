// Compares a real part (a STEP or STL file, e.g. exported from Onshape) with the part ork-cad makes
// from the design, and works out what to change so they match: OpenRocket fields (the shoulders'
// length and diameter, the body's length and radii, "Filled") and detail lines (chamfers and rounds
// on shoulder ends, rings of side holes, pockets and nut traps in the end faces). Then it builds the
// part with those changes and measures, surface to surface, what is still different. So nothing
// has to be measured and typed in by hand.
//
// Only nose cones and transitions so far. They're solids of revolution: their outline along the
// axis gives the OpenRocket numbers, and the details are read from where other surfaces meet the
// outside (holes) or the end faces (pockets, nut traps).

import type { RocketModel, TransitionPart } from "../ork/model.ts";
import { setComment, setFields, type XmlTools } from "../ork/write.ts";
import { parseFeatures } from "../features/parse.ts";
import { partSpan } from "../features/part-shape.ts";
import { NUT_NAMES, NUT_ROOM, nutSize } from "../features/hardware.ts";
import { buildPart } from "../geometry/parts.ts";
import { solidVolume } from "../geometry/measure.ts";
import { frameFor } from "../geometry/frame.ts";
import { transitionRadius } from "../geometry/shapes.ts";
import type { TriangleMesh } from "../geometry/stl.ts";
import { angleReference, cross, cylindrical, dot, findAxis, inertiaAxis, outline, scaleMesh, type Axis, type CadPart, type OutlinePoint, type V3 } from "./cad.ts";
import { MeshDistance, surfacePoints } from "./distance.ts";

export interface FieldChange {
  /** The .ork element, e.g. "aftshoulderlength". */
  field: string;
  /** What OpenRocket calls it. */
  label: string;
  from: string;
  to: string;
  /** As the .ork stores it (lengths in metres). */
  value: string;
}

export interface MatchResult {
  part: string;
  file: string;
  /** What the file's numbers were multiplied by to get millimetres. */
  scale: number;
  changes: FieldChange[];
  /** The part's detail lines after the changes: the ones it keeps and the new ones. */
  details: string[];
  added: string[];
  removed: string[];
  notes: string[];
  check: {
    /** mm³ */
    fileVolume: number;
    builtVolume: number;
    /** The furthest any point of either surface is from the other, mm. */
    maxDistance: number;
    /** Below this (mm), two surfaces count as the same: the two meshes' own allowance. */
    allowance: number;
    /** Places where the two still differ. */
    differences: string[];
  };
}

/** Closer than this (mm) counts as the same number. */
const SAME = 0.005;
const M = 1000;
const DEG = 180 / Math.PI;
/** The built part is cut into triangles this fine for the comparison. */
const BUILT_MESH = { tolerance: 0.01, angularTolerance: 0.1 };

export interface MatchOptions {
  /** Take the other end of the file's part as its fore end. */
  flip?: boolean;
  progress?: (text: string) => void;
  /**
   * The design is built with ork-cad's automatic details (src/features/auto.ts): the changes then
   * include "@auto off", so none are added to this part and it comes out just like the file.
   */
  auto?: boolean;
}

export function matchPart(model: RocketModel, part: TransitionPart, cad: CadPart, file: string, options: MatchOptions = {}): MatchResult {
  const progress = options.progress ?? (() => {});
  const notes = [...cad.notes];

  // --- Units: a file in inches or metres is a lot smaller than the part.
  progress("Finding the part's axis…");
  let mesh = cad.mesh;
  const span = partSpan(part);
  const rough = inertiaAxis(mesh);
  const along = cylindrical(mesh, rough, angleReference(rough)).s;
  const scale = unitScale((span.max - span.min) / (largest(along) - smallest(along)));
  if (scale !== 1) {
    mesh = scaleMesh(mesh, scale);
    notes.push(`The file's sizes are in ${UNIT_NAMES[scale]}; each was read as ${scale} mm.`);
  }
  const axis = findAxis(mesh);
  const fileVolume = cad.volume * scale ** 3;
  // Corners on one face square to the axis have the same position along it, up to the rounding
  // of the numbers in the file: 32-bit in an STL.
  let biggest = 0;
  for (let i = 0; i < mesh.vertices.length; i++) biggest = Math.max(biggest, Math.abs(mesh.vertices[i]));
  const same = Math.max(1e-6, cad.format === "stl" ? 5e-7 * biggest : 1e-9 * biggest);
  const raw = outline(mesh, axis, same);

  // --- Which end is the fore end, and the outline's parts: shoulders, body, ends.
  progress("Reading its outline…");
  const nose = part.foreRadius === 0;
  const forward = orient(raw, 1);
  const backward = orient(raw, -1);
  let sign: 1 | -1;
  if (nose) {
    // The tip.
    sign = forward[0].r <= forward[forward.length - 1].r ? 1 : -1;
  } else if (Math.abs(part.foreRadius - part.aftRadius) > 0.5) {
    // A transition between different sizes: the way round whose body ends fit the design's.
    const fit = (sh: Shape) => Math.abs(sh.bodyFore - part.foreRadius) + Math.abs(sh.bodyAft - part.aftRadius);
    sign = fit(parse(forward, same)) <= fit(parse(backward, same)) ? 1 : -1;
  } else {
    // The same size at both ends, so the shape can't tell: the fore end is the one toward the
    // file's +Z (or +Y, or +X if it lies that way), as in ork-cad's own files and most CAD models.
    const k = [2, 1, 0].find((i) => Math.abs(axis.dir[i]) > 0.5) ?? 2;
    sign = axis.dir[k] < 0 ? 1 : -1;
    notes.push(
      `Both ends of ${part.name} are the same size, so the end toward the file's ${"XYZ"[k]} axis was taken as its fore end; ` +
        "if that's wrong, compare the other way round.",
    );
  }
  if (options.flip) sign = sign === 1 ? -1 : 1;
  const shape = parse(sign === 1 ? forward : backward, same);
  const oriented: Axis = { point: axis.point, dir: sign === 1 ? axis.dir : (axis.dir.map((x) => -x) as V3) };
  // Positions along the part are measured from the fore end of its body, as details measure them.
  const zero = shape.bodyStart + (sign === 1 ? smallest(raw.map((p) => p.s)) : -largest(raw.map((p) => p.s)));

  const changes: FieldChange[] = [];
  const change = (field: string, label: string, from: number, to: number) =>
    changes.push({ field, label, from: `${mm(from)} mm`, to: `${mm(to)} mm`, value: String(Number((to / M).toFixed(6))) });

  // --- The body: length, end radii and shape.
  const bodyLength = shape.bodyEnd - shape.bodyStart;
  if (Math.abs(bodyLength - part.length) > SAME) {
    change("length", "Length", part.length, bodyLength);
    notes.push(`Changing the length moves everything behind ${part.name} along the rocket.`);
  }
  for (const [end, field, label, have, want] of [
    ["fore", "foreradius", "Fore radius", part.foreRadius, shape.bodyFore],
    ["aft", "aftradius", nose ? "Base radius" : "Aft radius", part.aftRadius, shape.bodyAft],
  ] as const) {
    if ((nose && end === "fore") || Math.abs(have - want) <= SAME) continue;
    if (isAuto(part, field)) {
      notes.push(
        `${label}: the file has ${mm(want)} mm, the design ${mm(have)} mm, OpenRocket's "auto" size from the tube ` +
          `next to it. Left as it is (the file is ${mm(Math.abs(have - want))} mm ${want < have ? "smaller" : "bigger"}).`,
      );
    } else {
      change(field, label, have, want);
    }
  }
  const probe: TransitionPart = { ...part, length: bodyLength, foreRadius: nose ? 0 : shape.bodyFore, aftRadius: shape.bodyAft };
  // Distances square to the design's outline (at a pointed tip the radius changes too fast for
  // a difference in radius to mean much).
  const design: OutlinePoint[] = [];
  for (let i = 0; i <= 4000; i++) {
    const u = (bodyLength * (1 - Math.cos((Math.PI * i) / 4000))) / 2;
    design.push({ s: u, r: transitionRadius(probe, u) });
  }
  let worst = 0;
  let worstAt = 0;
  for (const p of shape.body) {
    const d = toPolyline(design, p.s - shape.bodyStart, p.r);
    if (d > worst) [worst, worstAt] = [d, p.s - shape.bodyStart];
  }
  if (worst > 0.02) {
    notes.push(
      `The file's ${nose ? "nose" : "body"} isn't the design's ${part.shape} shape: it's up to ${mm(worst)} mm away from it, ` +
        `${mm(worstAt)} mm from the fore end.`,
    );
  }
  for (const t of shape.extraSteps) notes.push(`The file's outline has a step ${mm(t - shape.bodyStart)} mm from the fore end that the design doesn't.`);

  // --- Shoulders, and the shape of their ends.
  const endLines: string[] = [];
  for (const end of ["fore", "aft"] as const) {
    const found = shape[end];
    const sh = end === "fore" ? part.foreShoulder : part.aftShoulder;
    const has = sh.length > 0 && sh.radius > 0;
    const name = end === "fore" ? "Fore shoulder" : "Aft shoulder";
    if (!found) {
      if (has && !(nose && end === "fore")) change(`${end}shoulderlength`, `${name} length`, sh.length, 0);
      continue;
    }
    if (!has || Math.abs(sh.radius - found.radius) > SAME) change(`${end}shoulderradius`, `${name} radius`, sh.radius, found.radius);
    if (!has || Math.abs(sh.length - found.length) > SAME) change(`${end}shoulderlength`, `${name} length`, sh.length, found.length);
    const e = found.end;
    if (e.kind === "chamfer") {
      endLines.push(`@chamfer end=${end} inset=${mm(e.inset)} angle=${deg(e.angle)}${e.round > 0 ? ` round=${mm(e.round)}` : ""}`);
    } else if (e.kind === "round") {
      endLines.push(`@round end=${end} radius=${mm(e.radius)}`);
    } else if (e.kind === "other") {
      notes.push(`The ${end} shoulder's end is shaped some other way: it goes ${mm(e.inset)} mm in over its last ${mm(e.length)} mm.`);
    }
  }

  // --- Solid or hollow.
  const outerVolume = revolvedVolume(shape.all);
  const solid = fileVolume > 0.5 * outerVolume;
  if (solid && !part.filled) {
    changes.push({ field: "thickness", label: "Filled", from: "not ticked", to: "ticked", value: "filled" });
  } else if (!solid && part.filled) {
    notes.push(`The file's part is hollow (${Math.round((100 * fileVolume) / outerVolume)}% plastic), but "Filled" is ticked in the design.`);
  }

  // --- Details that aren't round: holes through the outside, pockets and nut traps in the ends.
  progress("Looking for holes, pockets and nut traps…");
  const placed = place(mesh, model, part, oriented, zero);
  const outsideAt = (s: number) => radiusAt(shape, s + shape.bodyStart);
  const front = -shape.bodyStart;
  const back = shape.all[shape.all.length - 1].s - shape.bodyStart;
  const steps = [front, back, ...shape.steps.map((t) => t - shape.bodyStart)];
  const faceTolerance = Math.max(0.002, 10 * same);
  const found = [
    ...sideHoles(mesh, placed, outsideAt, steps),
    // Pockets and nut traps need a solid part; a hollow one is open at its ends anyway.
    ...(solid ? endCuts(mesh, placed, outsideAt, steps, faceTolerance, "fore", front, shape.all[0].r) : []),
    ...(solid ? endCuts(mesh, placed, outsideAt, steps, faceTolerance, "aft", back, shape.all[shape.all.length - 1].r) : []),
  ];

  // --- The part's own detail lines stay, except edge shapes for the ends the file shows (and its
  // "@auto" lines, when "@auto off" takes their place).
  const own = part.comment.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("@"));
  const replaced = own.filter((l) => {
    if (options.auto && /^@auto\b/i.test(l)) return true;
    const m = /^@(chamfer|round)\b.*\bend=(fore|aft)\b/i.exec(l);
    return m !== null && shape[m[2] as "fore" | "aft"] !== undefined;
  });
  // Each new line has to work: the part is built with it before it's kept.
  progress(`Building ${part.name} with the changes…`);
  const details = own.filter((l) => !replaced.includes(l));
  let built;
  try {
    built = build(model, part, changes, [...details, ...endLines, ...found]);
    details.push(...endLines, ...found);
  } catch {
    // One of them doesn't work: add them one at a time to find which.
    built = build(model, part, changes, details);
    for (const line of [...endLines, ...found]) {
      try {
        built = build(model, part, changes, [...details, line]);
        details.push(line);
      } catch (e) {
        notes.push(`Found ${line}, but it can't be made: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  if (options.auto) {
    details.push("@auto off");
    if (!own.includes("@auto off")) {
      notes.push(`"@auto off" keeps ork-cad from adding its automatic details (vents, pocket, nut trap, rounded edges) to this part, so it comes out just like the file.`);
    }
  }
  progress("Comparing the surfaces…");
  const builtMesh = built.mesh(BUILT_MESH);
  const check = compare(placed.mesh, { vertices: Float64Array.from(builtMesh.vertices), triangles: Uint32Array.from(builtMesh.triangles) }, model, part, sag(placed, outsideAt, mesh));
  if (details.some((l) => !own.includes(l) && /\bangle=/.test(l) && !/^@chamfer/.test(l))) {
    notes.push("Angles are measured around the axis from the file's X axis, which is taken as the direction of the first fin.");
  }
  return {
    part: part.name,
    file,
    scale,
    changes,
    details,
    added: details.filter((l) => !own.includes(l)),
    removed: own.filter((l) => !details.includes(l)),
    notes,
    check: { fileVolume, builtVolume: solidVolume(built), ...check },
  };
}

/** A new .ork with the changes made to the part's fields and its detail lines. */
export function applyMatch(bytes: Uint8Array, part: TransitionPart, result: MatchResult, xml: XmlTools): Uint8Array {
  if (!part.id) throw new Error(`${part.name} has no OpenRocket id, so the changes can't be written into this file.`);
  const fields = Object.fromEntries(result.changes.map((c) => [c.field, c.value]));
  let out = Object.keys(fields).length ? setFields(bytes, part.id, fields, xml) : bytes;
  const keep = part.comment.split(/\r?\n/).filter((l) => !l.trim().startsWith("@"));
  out = setComment(out, part.id, [...keep, ...result.details].join("\n").trim(), xml);
  return out;
}

/** In words, for the command line and the website. */
export function matchText(r: MatchResult): string {
  const lines = [`${r.part} compared with ${r.file}:`];
  if (r.changes.length) {
    lines.push("  Change in OpenRocket:");
    for (const c of r.changes) lines.push(`    ${c.label}: ${c.from} → ${c.to}`);
  }
  if (r.added.length) {
    lines.push("  Add to its comment:");
    for (const l of r.added) lines.push(`    ${l}`);
  }
  if (r.removed.length) {
    lines.push("  Take out of its comment:");
    for (const l of r.removed) lines.push(`    ${l}`);
  }
  if (!r.changes.length && !r.added.length && !r.removed.length) lines.push("  Nothing to change.");
  for (const n of r.notes) lines.push(`  Note: ${n}`);
  const c = r.check;
  const volumes = `${cm3(c.fileVolume)} in the file, ${cm3(c.builtVolume)} built`;
  if (c.differences.length) {
    lines.push(`  Built with these, it still differs from the file (${volumes}):`);
    for (const d of c.differences) lines.push(`    ${d}`);
  } else {
    lines.push(`  Built with these, it matches the file: no point of either surface is more than ${mm(c.maxDistance)} mm from the other (${volumes}).`);
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------
// Reading the outline

type EndShape =
  | { kind: "sharp" }
  | { kind: "chamfer"; inset: number; angle: number; round: number }
  | { kind: "round"; radius: number }
  | { kind: "other"; inset: number; length: number };

interface Shoulder {
  radius: number;
  /** From the body's end to the shoulder's end face. */
  length: number;
  end: EndShape;
}

interface Shape {
  /** The whole outline, s from the fore end face (0). */
  all: OutlinePoint[];
  bodyStart: number;
  bodyEnd: number;
  bodyFore: number;
  bodyAft: number;
  body: OutlinePoint[];
  fore?: Shoulder;
  aft?: Shoulder;
  /** Where the outline has faces square to the axis, other than the ends. */
  steps: number[];
  extraSteps: number[];
}

/** The outline read from one end: s from 0 at that end. */
function orient(points: OutlinePoint[], sign: 1 | -1): OutlinePoint[] {
  const ordered = sign === 1 ? points : [...points].reverse();
  const s0 = sign * ordered[0].s;
  return ordered.map((p) => ({ s: sign * p.s - s0, r: p.r }));
}

interface Step {
  /** Indices of the outline points before and after the step. */
  i0: number;
  i1: number;
  s: number;
  from: number;
  to: number;
}

function parse(all: OutlinePoint[], same: number): Shape {
  const end = all[all.length - 1].s;
  const steps: Step[] = [];
  for (let i = 0; i + 1 < all.length; i++) {
    // A face square to the axis: the outline goes straight up or down at one position.
    if (all[i + 1].s !== all[i].s) continue;
    const last = steps[steps.length - 1];
    if (last && last.i1 === i) {
      last.i1 = i + 1;
      last.to = all[i + 1].r;
    } else {
      steps.push({ i0: i, i1: i + 1, s: all[i].s, from: all[i].r, to: all[i + 1].r });
    }
  }
  const inside = steps.filter((st) => Math.abs(st.from - st.to) > 0.01 && st.s > 0 && st.s < end);
  // A fore shoulder: the outline starts narrower and steps up, and nothing before the step is
  // wider; the biggest such step. An aft shoulder likewise at the other end.
  const biggest = (list: Step[]) => list.reduce<Step | undefined>((b, st) => (!b || Math.abs(st.to - st.from) > Math.abs(b.to - b.from) ? st : b), undefined);
  const foreStep = biggest(inside.filter((st) => st.to > st.from && all.slice(0, st.i0 + 1).every((p) => p.r <= st.from + SAME)));
  const aftStep = biggest(
    inside.filter((st) => st !== foreStep && st.to < st.from && (!foreStep || st.s > foreStep.s) && all.slice(st.i1).every((p) => p.r <= st.to + SAME)),
  );
  const bodyFrom = foreStep ? foreStep.i1 : 0;
  const bodyTo = aftStep ? aftStep.i0 : all.length - 1;
  return {
    all,
    bodyStart: foreStep ? foreStep.s : 0,
    bodyEnd: aftStep ? aftStep.s : end,
    bodyFore: all[bodyFrom].r,
    bodyAft: all[bodyTo].r,
    body: all.slice(bodyFrom, bodyTo + 1),
    fore: foreStep ? shoulder(all.slice(0, foreStep.i0 + 1).reverse().map((p) => ({ s: foreStep.s - p.s, r: p.r }))) : undefined,
    aft: aftStep ? shoulder(all.slice(aftStep.i1).map((p) => ({ s: p.s - aftStep.s, r: p.r }))) : undefined,
    steps: inside.map((st) => st.s),
    extraSteps: inside.filter((st) => st !== foreStep && st !== aftStep).map((st) => st.s),
  };
}

/** A shoulder's outline from the step (s = 0) to its end face: radius, length and end shape. */
function shoulder(seq: OutlinePoint[]): Shoulder {
  const radius = seq[0].r;
  return { radius, length: seq[seq.length - 1].s, end: endShape(seq, radius) };
}

/**
 * How a shoulder ends, from its outline (the side at radius R, then the end): sharp, a chamfer
 * perhaps started with a round, or a round into the end face. The sizes come from the corners where
 * one surface meets the next (a straight chamfer starts at a corner shared with the round before
 * it), which lie exactly on both, and every corner of the outline must then fit.
 */
function endShape(seq: OutlinePoint[], R: number): EndShape {
  const n = seq.length;
  const last = seq[n - 1];
  const inset = R - last.r;
  if (inset <= SAME) return { kind: "sharp" };
  // Radius at s of a chamfer at theta (from the axis) that starts with a round rho at c.
  const expected = (s: number, c: number, rho: number, theta: number) => {
    if (s <= c) return R;
    const a = rho * Math.sin(theta);
    if (s <= c + a + 1e-9) return R - rho + Math.sqrt(Math.max(0, rho * rho - (s - c) ** 2));
    return R - rho * (1 - Math.cos(theta)) - (s - c - a) * Math.tan(theta);
  };
  const fits = (c: number, rho: number, theta: number) => seq.every((p) => Math.abs(p.r - expected(p.s, c, rho, theta)) < 0.005 + 0.001 * rho);
  // The straight part at the end, and the corner where it starts.
  const angle = (i: number) => Math.atan2(seq[i].r - seq[i + 1].r, seq[i + 1].s - seq[i].s);
  const theta = angle(n - 2);
  let k = n - 2;
  while (k > 0 && Math.abs(angle(k - 1) - theta) < 0.05 / DEG) k--;
  const bend = seq[k];
  if (theta > 0.1 / DEG && theta < 89.9 / DEG) {
    const rho = R - bend.r < 1e-4 ? 0 : (R - bend.r) / (1 - Math.cos(theta));
    const c = bend.s - rho * Math.sin(theta);
    if (fits(c, rho, theta)) return { kind: "chamfer", inset, angle: theta, round: rho };
  }
  // A quarter circle into the end face.
  if (fits(last.s - inset, inset, Math.PI / 2)) return { kind: "round", radius: inset };
  let c = 0;
  while (c + 1 < n && Math.abs(seq[c + 1].r - R) < 0.005) c++;
  return { kind: "other", inset, length: last.s - seq[c].s };
}

/** Distance from (s, r) to a polyline with s rising. */
function toPolyline(line: OutlinePoint[], s: number, r: number): number {
  let lo = 0;
  let hi = line.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (line[mid].s < s) lo = mid;
    else hi = mid;
  }
  let best = Infinity;
  for (const dir of [-1, 1]) {
    for (let i = dir < 0 ? lo : hi - 1; i >= 0 && i + 1 < line.length; i += dir) {
      const [a, b] = [line[i], line[i + 1]];
      if (Math.min(Math.abs(a.s - s), Math.abs(b.s - s)) > best && (dir < 0 ? b.s < s : a.s > s)) break;
      const [ds, dr] = [b.s - a.s, b.r - a.r];
      const t = Math.max(0, Math.min(1, ((s - a.s) * ds + (r - a.r) * dr) / (ds * ds + dr * dr || 1)));
      best = Math.min(best, Math.hypot(a.s + t * ds - s, a.r + t * dr - r));
    }
  }
  return best;
}

/** The volume of the outline turned around the axis. */
function revolvedVolume(points: OutlinePoint[]): number {
  let v = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const h = points[i + 1].s - points[i].s;
    if (h <= 0) continue;
    const [a, b] = [points[i].r, points[i + 1].r];
    v += (Math.PI * h * (a * a + a * b + b * b)) / 3;
  }
  return v;
}

/** The outline's radius at t (from the fore end face); the larger one on a face square to the axis. */
function radiusAt(shape: Shape, t: number): number {
  const pts = shape.all;
  // The first point at or past t (the outline's s never goes down).
  let lo = 0;
  let hi = pts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].s < t - 1e-9) lo = mid + 1;
    else hi = mid;
  }
  let best = 0;
  for (let i = Math.max(0, lo - 1); i + 1 < pts.length && pts[i].s <= t + 1e-9; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    if (t < a.s - 1e-9 || t > b.s + 1e-9) continue;
    best = Math.max(best, b.s === a.s ? Math.max(a.r, b.r) : a.r + ((t - a.s) / (b.s - a.s)) * (b.r - a.r));
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// The file's part in the part's place on the rocket

interface Placed {
  /** The file's triangles moved to where the part sits on the rocket (see frame.ts). */
  mesh: TriangleMesh;
  /** For each corner: position from the fore end of the body, distance from the axis, and angle
   * (radians, from the file's X axis, which becomes the direction of the first fin). */
  s: Float64Array;
  r: Float64Array;
  angle: Float64Array;
}

function place(mesh: TriangleMesh, model: RocketModel, part: TransitionPart, axis: Axis, zero: number): Placed {
  const f = frameFor(model, part.instances[0]);
  const e1 = angleReference(axis);
  const e2 = cross(e1, axis.dir);
  const n = mesh.vertices.length / 3;
  const out: Placed = {
    mesh: { vertices: new Float64Array(3 * n), triangles: mesh.triangles },
    s: new Float64Array(n),
    r: new Float64Array(n),
    angle: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    const d: V3 = [mesh.vertices[3 * i] - axis.point[0], mesh.vertices[3 * i + 1] - axis.point[1], mesh.vertices[3 * i + 2] - axis.point[2]];
    const t = dot(d, axis.dir);
    const w: V3 = [d[0] - t * axis.dir[0], d[1] - t * axis.dir[1], d[2] - t * axis.dir[2]];
    const x = dot(w, e1);
    const y = dot(w, e2);
    out.s[i] = t - zero;
    out.r[i] = Math.hypot(x, y);
    out.angle[i] = Math.atan2(y, x);
    out.mesh.vertices.set([f.cx + x, f.cy + y, f.ztop - out.s[i]], 3 * i);
  }
  return out;
}

/** How far the file's triangles sag inside its real outside surface (STL files can be coarse). */
function sag(placed: Placed, outsideAt: (s: number) => number, mesh: TriangleMesh): number {
  const t = mesh.triangles;
  let worst = 0;
  for (let i = 0; i < t.length; i += 3) {
    const [a, b, c] = [t[i], t[i + 1], t[i + 2]];
    if (![a, b, c].every((k) => placed.r[k] >= outsideAt(placed.s[k]) - 0.003)) continue;
    // Not across a face square to the axis (an end or a step), only along the outside.
    if (Math.max(placed.s[a], placed.s[b], placed.s[c]) - Math.min(placed.s[a], placed.s[b], placed.s[c]) < 1e-3) continue;
    const v = placed.mesh.vertices;
    const x = (v[3 * a] + v[3 * b] + v[3 * c]) / 3;
    const y = (v[3 * a + 1] + v[3 * b + 1] + v[3 * c + 1]) / 3;
    const s = (placed.s[a] + placed.s[b] + placed.s[c]) / 3;
    const f = v[3 * a] - placed.r[a] * Math.cos(placed.angle[a]); // the axis, x
    const g = v[3 * a + 1] - placed.r[a] * Math.sin(placed.angle[a]);
    worst = Math.max(worst, outsideAt(s) - Math.hypot(x - f, y - g));
  }
  return worst;
}

// ---------------------------------------------------------------------------------------------
// Details

/**
 * Rings of holes through the outside. Where a hole's wall meets the outside there's a loop of
 * corners on the outside surface that belong to triangles going inward; each loop is fitted with
 * a hole running straight out from the axis.
 */
function sideHoles(mesh: TriangleMesh, p: Placed, outsideAt: (s: number) => number, steps: number[]): string[] {
  const n = p.s.length;
  // On a face square to the axis (a step or an end) the outline has two radii, so corners there
  // aren't looked at: they count as outside.
  const onStep = new Uint8Array(n);
  const outside = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    onStep[i] = steps.some((s) => Math.abs(p.s[i] - s) <= 0.01) ? 1 : 0;
    outside[i] = onStep[i] || p.r[i] >= outsideAt(p.s[i]) - 0.003 ? 1 : 0;
  }
  const rim = new Set<number>();
  const t = mesh.triangles;
  for (let i = 0; i < t.length; i += 3) {
    const tri = [t[i], t[i + 1], t[i + 2]];
    if (tri.every((k) => outside[k])) continue;
    for (const k of tri) if (outside[k] && !onStep[k]) rim.add(k);
  }
  const holes: { s: number; d: number; angle: number }[] = [];
  for (const g of joined(mesh, rim)) {
    if (g.length < 6) continue;
    const fit = radialHole(g.map((k) => ({ s: p.s[k], r: p.r[k], a: p.angle[k] })));
    const outside = largest(g.map((k) => p.r[k]));
    if (fit && fit.d >= 0.3 && fit.d < outside && fit.residual < 0.005 + 0.002 * fit.d) holes.push(fit);
  }
  const lines: string[] = [];
  const used = new Set<number>();
  holes.forEach((h, i) => {
    if (used.has(i)) return;
    const ring = holes.map((o, j) => ({ ...o, j })).filter((o) => Math.abs(o.s - h.s) < 0.05 && Math.abs(o.d - h.d) < 0.05);
    for (const o of ring) used.add(o.j);
    const count = ring.length;
    const step = (2 * Math.PI) / count;
    const first = smallest(ring.map((o) => ((o.angle % step) + step) % step));
    const even = ring.every((o) => Math.abs(wrap(o.angle - first - step * Math.round((o.angle - first) / step))) < 0.5 / DEG);
    const diameter = mm(Math.round(ring.reduce((sum, o) => sum + o.d, 0) / count / 0.01) * 0.01);
    const at = mm(ring.reduce((sum, o) => sum + o.s, 0) / count);
    if (even) {
      lines.push(`@side-holes count=${count} diameter=${diameter} at=${at}${first > 0.01 / DEG && first < step - 0.01 / DEG ? ` angle=${deg(first)}` : ""}`);
    } else {
      for (const o of ring) lines.push(`@side-holes count=1 diameter=${diameter} at=${mm(o.s)} angle=${deg((o.angle + 2 * Math.PI) % (2 * Math.PI))}`);
    }
  });
  return lines;
}

/** A hole straight out from the axis through points on its rim: where along, which way, how wide. */
function radialHole(pts: { s: number; r: number; a: number }[]): { s: number; angle: number; d: number; residual: number } | undefined {
  let angle = circularMean(pts.map((q) => q.a));
  const meanR = pts.reduce((sum, q) => sum + q.r, 0) / pts.length;
  let fit = { cx: 0, cy: 0, radius: 0, residual: Infinity };
  for (let pass = 0; pass < 4; pass++) {
    fit = circle2(pts.map((q) => [q.s, q.r * Math.sin(q.a - angle)]));
    angle += fit.cy / meanR;
  }
  if (!Number.isFinite(fit.radius)) return undefined;
  return { s: fit.cx, angle, d: 2 * fit.radius, residual: fit.residual };
}

/**
 * Pockets and nut traps cut in from an end face: the edge of the opening in the face is a loop of
 * corners on the face that belong to triangles going into the part.
 */
function endCuts(
  mesh: TriangleMesh,
  p: Placed,
  outsideAt: (s: number) => number,
  steps: number[],
  tolerance: number,
  end: "fore" | "aft",
  sf: number,
  faceRadius: number,
): string[] {
  if (faceRadius < 1) return []; // a nose tip, not a face
  const n = p.s.length;
  const onFace = (k: number) => Math.abs(p.s[k] - sf) <= tolerance;
  const rim = new Set<number>();
  const t = mesh.triangles;
  for (let i = 0; i < t.length; i += 3) {
    const tri = [t[i], t[i + 1], t[i + 2]];
    if (tri.every(onFace)) continue;
    for (const k of tri) if (onFace(k) && p.r[k] < faceRadius - 0.02) rim.add(k);
  }
  // Corners inside the part: not on its outside, not on an end or step face.
  const inside = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    inside[k] = p.r[k] < outsideAt(p.s[k]) - 0.003 && steps.every((s) => Math.abs(p.s[k] - s) > tolerance) ? 1 : 0;
  }
  const neighbours = adjacency(mesh);
  const lines: string[] = [];
  for (const g of joined(mesh, rim)) {
    if (g.length < 6) continue;
    // The cavity behind the opening: everything joined to it by triangles, inside the part, and
    // the corners where it meets the outside (a nut's slot does).
    const cavity = new Set<number>(g);
    const rimOut = new Set<number>();
    const queue = [...g];
    while (queue.length) {
      for (const j of neighbours[queue.pop()!]) {
        if (cavity.has(j)) continue;
        if (inside[j]) {
          cavity.add(j);
          queue.push(j);
        } else if (!onFace(j)) {
          rimOut.add(j);
        }
      }
    }
    let depth = 0;
    for (const k of cavity) depth = Math.max(depth, Math.abs(p.s[k] - sf));
    const xy = g.map((k) => [p.r[k] * Math.cos(p.angle[k]), p.r[k] * Math.sin(p.angle[k])] as [number, number]);
    const round = circle2(xy);
    if (round.residual < 0.01 + 0.002 * round.radius) {
      if (Math.hypot(round.cx, round.cy) > 0.05) continue; // a hole off the axis: not a pocket
      const nut = nutTrap(p, [...cavity], [...rimOut], end, sf, round.radius);
      lines.push(nut ?? `@pocket diameter=${mm2(2 * round.radius)} depth=${mm2(depth)} end=${end}`);
      continue;
    }
    const rect = boundingRectangle(hull(xy));
    if (Math.hypot(rect.cx, rect.cy) > 0.2) continue;
    const corner = Math.sqrt(Math.max(0, (rect.w * rect.h - rect.area) / (4 - Math.PI)));
    lines.push(
      `@pocket size=${mm2(rect.w)}x${mm2(rect.h)} depth=${mm2(depth)}${corner > 0.05 ? ` corner=${mm2(corner)}` : ""} end=${end}` +
        (rect.angle > 0.01 / DEG ? ` angle=${deg(rect.angle)}` : ""),
    );
  }
  return lines;
}

/**
 * A captive nut: a screw hole in the end face (one of the sizes ork-cad knows) leading to a wider
 * pocket for the nut, with a slot out to the side to slide it in.
 */
function nutTrap(p: Placed, cavity: number[], rimOut: number[], end: "fore" | "aft", sf: number, radius: number): string | undefined {
  const size = NUT_NAMES.find((name) => Math.abs(nutSize(name)!.hole - 2 * radius) < 0.05);
  if (!size) return undefined;
  const nut = nutSize(size)!;
  const flats = nut.flats + NUT_ROOM.flats;
  const corner = flats / Math.sqrt(3);
  // The nut pocket: the part of the cavity wider than the screw hole, and its slot, which opens
  // on the outside of the part.
  const wider = cavity.filter((k) => p.r[k] > radius + 0.3);
  if (!wider.length) return undefined;
  const depths = wider.map((k) => Math.abs(p.s[k] - sf));
  const [d0, d1] = [smallest(depths), largest(depths)];
  const slot = rimOut.filter((k) => p.r[k] > corner + 0.5 && Math.abs(p.s[k] - sf) > d0 - 0.01 && Math.abs(p.s[k] - sf) < d1 + 0.01);
  if (!slot.length) return undefined;
  const angle = circularMean(slot.map((k) => p.angle[k]));
  const hole = cavity.filter((k) => p.r[k] <= radius + 0.05);
  const bolt = largest(hole.map((k) => Math.abs(p.s[k] - sf))) - radius;
  const thickness = d1 - d0;
  const extra = [
    Math.abs(thickness - (nut.thickness + NUT_ROOM.thickness)) > 0.02 ? ` thickness=${mm(thickness)}` : "",
    Math.abs(bolt - (d0 + thickness + 3)) > 0.02 ? ` bolt=${mm(bolt)}` : "",
  ].join("");
  return `@nut-trap size=${size} depth=${mm(d0)} end=${end} angle=${deg(angle)}${extra}`;
}

// ---------------------------------------------------------------------------------------------
// Building with the changes, and comparing surfaces

function build(model: RocketModel, part: TransitionPart, changes: FieldChange[], details: string[]) {
  const p: TransitionPart = { ...part, foreShoulder: { ...part.foreShoulder }, aftShoulder: { ...part.aftShoulder } };
  for (const c of changes) {
    const v = Number(c.value) * M;
    if (c.field === "length") p.length = v;
    else if (c.field === "foreradius") p.foreRadius = v;
    else if (c.field === "aftradius") p.aftRadius = v;
    else if (c.field === "foreshoulderradius") p.foreShoulder.radius = v;
    else if (c.field === "foreshoulderlength") p.foreShoulder.length = v;
    else if (c.field === "aftshoulderradius") p.aftShoulder.radius = v;
    else if (c.field === "aftshoulderlength") p.aftShoulder.length = v;
    else if (c.field === "thickness") p.filled = true;
  }
  p.features = parseFeatures(details.join("\n")).features;
  const built = buildPart(p, model);
  if (!built) throw new Error(`${part.name} can't be built.`);
  return built.solids[0];
}

/**
 * Surface to surface: points all over each part, and how far each is from the other part's
 * surface. Both are triangles, so up to `allowance` apart counts as the same.
 */
function compare(file: TriangleMesh, built: TriangleMesh, model: RocketModel, part: TransitionPart, fileSag: number) {
  const allowance = Math.max(0.03, 2 * fileSag + 0.02);
  const spacing = 1;
  const differences: string[] = [];
  let maxDistance = 0;
  const f = frameFor(model, part.instances[0]);
  for (const [from, to, what] of [
    [file, built, "the file has surface where the built part has none"],
    [built, file, "the built part has surface where the file has none"],
  ] as const) {
    const index = new MeshDistance(to, 0.5);
    const pts = thin(surfacePoints(from, spacing), 300000);
    const far: number[] = [];
    const dist: number[] = [];
    for (let k = 0; k < pts.length; k += 3) {
      const d = index.distance(pts[k], pts[k + 1], pts[k + 2]);
      if (d <= allowance) maxDistance = Math.max(maxDistance, d);
      else far.push(k / 3);
    }
    // How far the far ones are: look further out (up to 2 mm), for an even share of them.
    const every = Math.max(1, Math.ceil(far.length / 400));
    for (let i = 0; i < far.length; i++) {
      const k = 3 * far[i];
      const wide = i % every === 0 ? index.distance(pts[k], pts[k + 1], pts[k + 2], 4) : NaN;
      dist.push(wide);
      if (!Number.isNaN(wide)) maxDistance = Math.max(maxDistance, Number.isFinite(wide) ? wide : 2);
    }
    if (!far.length) continue;
    const xyz = new Float64Array(3 * far.length);
    far.forEach((k, i) => xyz.set([pts[3 * k], pts[3 * k + 1], pts[3 * k + 2]], 3 * i));
    for (const g of clusters(xyz, far.map((_, i) => i), 1).sort((a, b) => b.length - a.length).slice(0, 6)) {
      const s = g.map((i) => f.ztop - xyz[3 * i + 2]);
      const r = g.map((i) => Math.hypot(xyz[3 * i] - f.cx, xyz[3 * i + 1] - f.cy));
      const a = circularMean(g.map((i) => Math.atan2(xyz[3 * i + 1] - f.cy, xyz[3 * i] - f.cx)));
      const d = largest(g.map((i) => (Number.isNaN(dist[i]) ? allowance : dist[i])));
      differences.push(
        `${what}: ${mm(smallest(s))} to ${mm(largest(s))} mm from the fore end of the body, ` +
          `${mm(smallest(r))} to ${mm(largest(r))} mm from the axis, around ${deg((a + 2 * Math.PI) % (2 * Math.PI))}°, ` +
          (Number.isFinite(d) ? `up to ${mm(d)} mm away` : "more than 2 mm away"),
      );
    }
  }
  return { maxDistance, allowance, differences };
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers

/** An even share of at most `most` points (x, y, z each). */
function thin(pts: Float64Array, most: number): Float64Array {
  const n = pts.length / 3;
  if (n <= most) return pts;
  const every = Math.ceil(n / most);
  const out = new Float64Array(3 * Math.ceil(n / every));
  for (let i = 0, j = 0; i < n; i += every, j++) out.set(pts.subarray(3 * i, 3 * i + 3), 3 * j);
  return out;
}

/** Groups of points (indices into xyz) that are within about `cell` of each other. */
function clusters(xyz: ArrayLike<number>, which: number[], cell: number): number[][] {
  const cells = new Map<string, number[]>();
  for (const k of which) {
    const id = `${Math.floor(xyz[3 * k] / cell)},${Math.floor(xyz[3 * k + 1] / cell)},${Math.floor(xyz[3 * k + 2] / cell)}`;
    const list = cells.get(id);
    if (list) list.push(k);
    else cells.set(id, [k]);
  }
  const ids = [...cells.keys()];
  const index = new Map(ids.map((id, i) => [id, i]));
  const parent = ids.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  ids.forEach((id, i) => {
    const [x, y, z] = id.split(",").map(Number);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const j = index.get(`${x + dx},${y + dy},${z + dz}`);
          if (j !== undefined) parent[find(j)] = find(i);
        }
      }
    }
  });
  const groups = new Map<number, number[]>();
  ids.forEach((id, i) => {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(...cells.get(id)!);
    else groups.set(root, [...cells.get(id)!]);
  });
  return [...groups.values()];
}

/** Groups of corners (of a set) joined to each other by triangle edges. */
function joined(mesh: TriangleMesh, set: Set<number>): number[][] {
  const parent = new Map<number, number>();
  for (const k of set) parent.set(k, k);
  const find = (k: number): number => {
    while (parent.get(k) !== k) {
      const up = parent.get(parent.get(k)!)!;
      parent.set(k, up);
      k = up;
    }
    return k;
  };
  const t = mesh.triangles;
  for (let i = 0; i < t.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const [a, b] = [t[i + e], t[i + ((e + 1) % 3)]];
      if (set.has(a) && set.has(b)) parent.set(find(a), find(b));
    }
  }
  const groups = new Map<number, number[]>();
  for (const k of set) {
    const root = find(k);
    const list = groups.get(root);
    if (list) list.push(k);
    else groups.set(root, [k]);
  }
  return [...groups.values()];
}

/** The corners each corner shares a triangle edge with. */
function adjacency(mesh: TriangleMesh): number[][] {
  const out: number[][] = Array.from({ length: mesh.vertices.length / 3 }, () => []);
  const t = mesh.triangles;
  for (let i = 0; i < t.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const [a, b] = [t[i + k], t[i + ((k + 1) % 3)]];
      out[a].push(b);
      out[b].push(a);
    }
  }
  return out;
}

/** Least-squares circle through 2D points (Kasa), and how far the points are from it at most. */
function circle2(points: [number, number][]): { cx: number; cy: number; radius: number; residual: number } {
  const n = points.length;
  const mx = points.reduce((s, q) => s + q[0], 0) / n;
  const my = points.reduce((s, q) => s + q[1], 0) / n;
  let [suu, svv, suv, suuu, svvv, suvv, svuu] = [0, 0, 0, 0, 0, 0, 0];
  for (const [x, y] of points) {
    const [u, v] = [x - mx, y - my];
    suu += u * u;
    svv += v * v;
    suv += u * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  const bu = (suuu + suvv) / 2;
  const bv = (svvv + svuu) / 2;
  const uc = (bu * svv - bv * suv) / det;
  const vc = (bv * suu - bu * suv) / det;
  const radius = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  const [cx, cy] = [uc + mx, vc + my];
  const residual = largest(points.map(([x, y]) => Math.abs(Math.hypot(x - cx, y - cy) - radius)));
  return { cx, cy, radius, residual };
}

/** Convex hull (monotone chain), counter-clockwise. */
function hull(points: [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: [number, number][]) => {
    const out: [number, number][] = [];
    for (const q of list) {
      while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
      out.push(q);
    }
    return out.slice(0, -1);
  };
  return [...half(p), ...half([...p].reverse())];
}

/** The smallest rectangle around a convex polygon (it has a side along one of the polygon's edges). */
function boundingRectangle(h: [number, number][]): { w: number; h: number; angle: number; cx: number; cy: number; area: number } {
  let area = 0;
  for (let i = 0; i < h.length; i++) {
    const [a, b] = [h[i], h[(i + 1) % h.length]];
    area += a[0] * b[1] - b[0] * a[1];
  }
  area = Math.abs(area) / 2;
  let best = { w: 0, h: 0, angle: 0, cx: 0, cy: 0, area, size: Infinity };
  for (let i = 0; i < h.length; i++) {
    const [a, b] = [h[i], h[(i + 1) % h.length]];
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const [c, s] = [Math.cos(angle), Math.sin(angle)];
    const u = h.map((q) => q[0] * c + q[1] * s);
    const v = h.map((q) => -q[0] * s + q[1] * c);
    const [u0, u1, v0, v1] = [smallest(u), largest(u), smallest(v), largest(v)];
    const size = (u1 - u0) * (v1 - v0);
    if (size < best.size - 1e-9) {
      const [um, vm] = [(u0 + u1) / 2, (v0 + v1) / 2];
      // ork-cad's pocket has its width along its angle from the first fin.
      let [w, hh, turned] = [u1 - u0, v1 - v0, angle];
      if (hh > w + 1e-9) [w, hh, turned] = [hh, w, angle + Math.PI / 2];
      turned = ((turned % Math.PI) + Math.PI) % Math.PI;
      if (Math.PI - turned < 1e-6) turned = 0;
      best = { w, h: hh, angle: turned, cx: um * c - vm * s, cy: um * s + vm * c, area, size };
    }
  }
  return best;
}

const UNIT_NAMES: Record<number, string> = { 1: "millimetres", 10: "centimetres", 25.4: "inches", 1000: "metres" };

/** The unit a file is in, from how long it is compared with the design: mm, cm, inches or metres. */
function unitScale(ratio: number): number {
  let best = 1;
  for (const u of [1, 10, 25.4, 1000]) if (Math.abs(Math.log(ratio / u)) < Math.abs(Math.log(ratio / best))) best = u;
  return Math.abs(Math.log(ratio / best)) < Math.log(1.3) ? best : 1;
}

function isAuto(part: TransitionPart, field: string): boolean {
  return (part.node?.fields.get(field)?.text ?? "").trim().toLowerCase().startsWith("auto");
}

/** The largest and smallest of many numbers (Math.max(...list) runs out of stack on big lists). */
function largest(list: ArrayLike<number>): number {
  let best = -Infinity;
  for (let i = 0; i < list.length; i++) if (list[i] > best) best = list[i];
  return best;
}

function smallest(list: ArrayLike<number>): number {
  let best = Infinity;
  for (let i = 0; i < list.length; i++) if (list[i] < best) best = list[i];
  return best;
}

function circularMean(angles: number[]): number {
  return Math.atan2(
    angles.reduce((s, a) => s + Math.sin(a), 0),
    angles.reduce((s, a) => s + Math.cos(a), 0),
  );
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** A size read from where corners are: mm, to 0.01. */
function mm2(v: number): string {
  return String(Number(v.toFixed(2)));
}

/** A length for a detail line or a message: mm, at most 3 decimals. */
function mm(v: number): string {
  return String(Number(v.toFixed(3)));
}

function deg(radians: number): string {
  return String(Number((radians * DEG).toFixed(2)));
}

function cm3(v: number): string {
  return `${(v / 1000).toFixed(3)} cm³`;
}
