// OpenRocket 24.12's nose cone / transition profile math (Transition.java), ported line for line.
// OpenRocket works in metres; everything here is in millimetres, so its length constants are
// converted (they're marked below). Keeping the exact same formulas means our parts and
// OpenRocket's own numbers describe the same shape.

import type { ShapeType, TransitionPart } from "../ork/model.ts";

const MINFEATURE = 0.001; // dimensionless where used below (ogive shape parameter)
const CLIP_PRECISION = 0.1; // mm (0.0001 m in OpenRocket)
const POWER_EPSILON = 0.00001; // dimensionless shape parameter
const POWER_X_EPSILON = 0.01; // mm (0.00001 m in OpenRocket)

/** Shapes OpenRocket lets you "clip" (Transition.Shape.isClippable). */
export const CLIPPABLE = new Set<ShapeType>(["ellipsoid", "power", "haack"]);

/** Transition.Shape.getRadius: radius at distance x from the tip of a nose of the given length and base radius. */
export function shapeRadius(shape: ShapeType, x: number, radius: number, length: number, param: number): number {
  switch (shape) {
    case "conical":
      return (radius * x) / length;
    case "ogive": {
      // Impossible to calculate an ogive for length < radius, so OpenRocket scales instead.
      if (length < radius) {
        x = (x * radius) / length;
        length = radius;
      }
      if (param < MINFEATURE) return shapeRadius("conical", x, radius, length, param);
      const R = safeSqrt(
        ((length ** 2 + radius ** 2) * (((2 - param) * length) ** 2 + (param * radius) ** 2)) /
          (4 * (param * radius) ** 2),
      );
      const L = length / param;
      const y0 = safeSqrt(R * R - L * L);
      return safeSqrt(R * R - (L - x) * (L - x)) - y0;
    }
    case "ellipsoid":
      x = (x * radius) / length;
      return safeSqrt(2 * radius * x - x * x);
    case "power":
      if (param <= POWER_EPSILON) return x <= POWER_X_EPSILON ? 0 : radius;
      return radius * Math.pow(x / length, param);
    case "parabolic":
      return radius * ((2 * x) / length - param * (x / length) ** 2) / (2 - param);
    case "haack": {
      const theta = Math.acos(1 - (2 * x) / length);
      if (param === 0) return radius * safeSqrt((theta - Math.sin(2 * theta) / 2) / Math.PI);
      return radius * safeSqrt((theta - Math.sin(2 * theta) / 2 + param * Math.sin(theta) ** 3) / Math.PI);
    }
  }
}

type Profile = Pick<TransitionPart, "shape" | "shapeParameter" | "clipped" | "foreRadius" | "aftRadius" | "length">;

/** Transition.getRadius: outer radius at distance x from the component's fore end. */
export function transitionRadius(t: Profile, x: number): number {
  if (x < 0) return t.foreRadius;
  if (x >= t.length) return t.aftRadius;
  let r1 = t.foreRadius;
  let r2 = t.aftRadius;
  if (r1 === r2) return r1;
  if (r1 > r2) {
    x = t.length - x;
    [r1, r2] = [r2, r1];
  }
  if (isClipped(t)) {
    const clip = clipLength(t);
    return shapeRadius(t.shape, clip + x, r2, clip + t.length, t.shapeParameter);
  }
  return r1 + shapeRadius(t.shape, x, r2 - r1, t.length, t.shapeParameter);
}

export function isClipped(t: Profile): boolean {
  return t.clipped && CLIPPABLE.has(t.shape);
}

/**
 * Transition.calculateClip: the length cut off the tip of a full nose shape so that it starts at
 * the smaller radius. Same binary search and precision as OpenRocket.
 */
export function clipLength(t: Profile): number {
  let r1 = Math.min(t.foreRadius, t.aftRadius);
  const r2 = Math.max(t.foreRadius, t.aftRadius);
  if (r1 === 0 || t.length <= 0) return 0;
  const len = t.length;
  const f = (c: number) => shapeRadius(t.shape, c, r2, c + len, t.shapeParameter);
  let min = 0;
  let max = len;
  let n = 0;
  while (f(max) - r1 < 0) {
    min = max;
    max *= 2;
    if (++n > 10) break;
  }
  for (;;) {
    const c = (min + max) / 2;
    if (max - min < CLIP_PRECISION) return c;
    if (f(c) - r1 > 0) max = c;
    else min = c;
  }
}

function safeSqrt(v: number): number {
  return v <= 0 ? 0 : Math.sqrt(v);
}
