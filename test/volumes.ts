// Two independent ways to work out a nose cone's or transition's volume, used by
// openrocket.test.ts:
//  - openRocketVolume: OpenRocket 24.12's own mass-model formula, ported line for line, so its
//    numbers can be checked exactly;
//  - wallVolume: the exact volume of the wall we build (thickness measured perpendicular to the
//    surface), from a fine polygon of its cross-section, without the CAD kernel.

import type { Shoulder, TransitionPart } from "../src/ork/model.ts";
import { transitionRadius } from "../src/geometry/shapes.ts";

type P2 = [number, number];

/**
 * SymmetricComponent.calculateProperties (the volume part) plus Transition's shoulders, in mm³.
 * OpenRocket cuts the part into 128 slices and treats each as a hollow cone frustum, whose inside
 * radius is the outside radius less thickness / cos(slope of the slice).
 */
export function openRocketVolume(t: TransitionPart): number {
  const DIVISIONS = 128;
  const MINFEATURE = 1; // mm (Transition.MINFEATURE, 0.001 m)
  const L = t.length;
  let volume = 0;
  for (let n = 0; n < DIVISIONS; n++) {
    const x1 = (n * L) / DIVISIONS;
    const x2 = ((n + 1) * L) / DIVISIONS;
    const l = x2 - x1;
    const r1o = transitionRadius(t, x1);
    const r2o = transitionRadius(t, x2);
    const hyp = Math.hypot(r2o - r1o, l);
    const height = (t.thickness * hyp) / l;
    const r1i = t.filled ? 0 : Math.max(r1o - height, 0);
    const r2i = t.filled ? 0 : Math.max(r2o - height, 0);
    volume += l * (r1o * r1o + r1o * r2o + r2o * r2o) - l * (r1i * r1i + r1i * r2i + r2i * r2i);
  }
  volume *= Math.PI / 3;
  const fore = t.foreShoulder;
  const aft = t.aftShoulder;
  if (fore.length > MINFEATURE || aft.length > MINFEATURE) {
    for (const sh of [fore, aft]) {
      const ir = Math.max(sh.radius - sh.thickness, 0);
      if (sh.capped) volume += Math.PI * ir * ir * sh.thickness;
      if (sh.length > MINFEATURE) volume += Math.PI * Math.max(sh.radius ** 2 - ir ** 2, 0) * sh.length;
    }
  }
  return volume;
}

/**
 * The exact volume of the part as we build it: the wall's inside surface is the outside one moved
 * in by the thickness, perpendicular to it, trimmed at the axis and the end faces and continued
 * straight where it stops short of an end face; shoulders are tubes with a cap as thick as their
 * wall. Worked out with Pappus's theorem on a polygon of the cross-section with 20000 points per
 * curve, so it's independent of the CAD kernel and its spline fitting. Shapes whose wall is
 * thicker than their curvature at a sharp end aren't handled (returns undefined).
 */
export function wallVolume(t: TransitionPart): number | undefined {
  const N = 20000;
  const L = t.length;
  const outer: P2[] = Array.from({ length: N + 1 }, (_, i) => {
    const s = (L * i) / N;
    return [s, transitionRadius(t, s)];
  });
  const r1 = outer[0][1];
  const r2 = outer[N][1];
  let section: P2[];
  if (t.filled || t.thickness <= 0) {
    section = [[0, 0], ...outer, [L, 0]];
  } else {
    const inner = insideCurve(outer, t.thickness, L);
    if (inner === undefined) return undefined;
    // Outside from fore to aft, down the aft face, inside back to the front, up the fore face.
    section = [...outer];
    const end = inner[inner.length - 1];
    const start = inner[0];
    if (end[0] < L) section.push([L, 0]);
    section.push(...[...inner].reverse());
    if (start[0] > 0) section.push([0, 0]);
  }
  let volume = Math.abs(pappus(section));
  for (const [sh, r] of [
    [t.foreShoulder, r1],
    [t.aftShoulder, r2],
  ] as [Shoulder, number][]) {
    if (sh.length <= 0 || sh.radius <= 0 || r <= 0 || (!t.filled && sh.thickness <= 0)) continue;
    const ri = t.filled ? 0 : Math.max(0, sh.radius - sh.thickness);
    const open = sh.capped ? Math.max(0, sh.length - sh.thickness) : sh.length;
    volume += Math.PI * (sh.radius ** 2 * sh.length - ri ** 2 * open);
  }
  return volume;
}

/** Volume swept by a closed (s, r) polygon turning about the axis (signed). */
function pappus(points: P2[]): number {
  let v = 0;
  for (let i = 0; i < points.length; i++) {
    const [s1, a] = points[i];
    const [s2, b] = points[(i + 1) % points.length];
    v += (s2 - s1) * (a * a + a * b + b * b);
  }
  return (v * Math.PI) / 3;
}

/** The outside polyline moved in by w along its normals, clipped to 0 <= s <= L and r >= 0. */
function insideCurve(outer: P2[], w: number, L: number): P2[] | undefined {
  const moved: P2[] = outer.map((p, i) => {
    const a = outer[Math.max(0, i - 1)];
    const b = outer[Math.min(outer.length - 1, i + 1)];
    const ds = b[0] - a[0];
    const dr = b[1] - a[1];
    const n = Math.hypot(ds, dr);
    return [p[0] + (w * dr) / n, p[1] - (w * ds) / n];
  });
  for (let i = 1; i < moved.length; i++) if (moved[i][0] <= moved[i - 1][0]) return undefined; // folds over
  const inside = (p: P2) => p[0] >= 0 && p[0] <= L && p[1] >= 0;
  const out: P2[] = [];
  for (let i = 0; i < moved.length; i++) {
    const p = moved[i];
    const q = moved[i - 1];
    if (q && inside(p) !== inside(q)) out.push(clipPoint(q, p, L));
    if (inside(p)) out.push(p);
  }
  if (out.length < 2) return undefined;
  // Continue straight to an end face it stops short of (or to the axis, if that comes first).
  const extend = (p: P2, toward: P2, sTarget: number): P2 => {
    const ds = p[0] - toward[0];
    const dr = p[1] - toward[1];
    let k = (sTarget - p[0]) / ds;
    if (p[1] + k * dr < 0) k = -p[1] / dr;
    return [p[0] + k * ds, Math.max(0, p[1] + k * dr)];
  };
  const first = out[0];
  if (first[0] > 1e-9 && first[1] > 1e-9) out.unshift(extend(first, out[1], 0));
  const last = out[out.length - 1];
  if (last[0] < L - 1e-9 && last[1] > 1e-9) out.push(extend(last, out[out.length - 2], L));
  return out;
}

/** Where the segment q-p crosses the boundary of 0 <= s <= L, r >= 0. */
function clipPoint(q: P2, p: P2, L: number): P2 {
  let k = 1;
  // The largest step from the inside point toward the other that stays inside.
  const qInside = q[0] >= 0 && q[0] <= L && q[1] >= 0;
  const from = qInside ? q : p;
  const to = qInside ? p : q;
  const dS = to[0] - from[0];
  const dR = to[1] - from[1];
  if (dS < 0) k = Math.min(k, (0 - from[0]) / dS);
  if (dS > 0) k = Math.min(k, (L - from[0]) / dS);
  if (dR < 0) k = Math.min(k, (0 - from[1]) / dR);
  return [from[0] + k * dS, Math.max(0, from[1] + k * dR)];
}
