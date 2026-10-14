// What details need to know about a part's shape: its ends, its outside radius along the axis,
// and whether it's solid. Positions s are measured from the fore end of the part's body;
// negative values are inside a fore shoulder.

import type { Part, TransitionPart } from "../ork/model.ts";
import { transitionRadius } from "../geometry/shapes.ts";
import { FeatureError, type SideHoles } from "./parse.ts";

/** Whether a nose cone or transition shoulder gets built (see buildTransition in parts.ts). */
export function hasShoulder(t: TransitionPart, side: "fore" | "aft"): boolean {
  const sh = side === "fore" ? t.foreShoulder : t.aftShoulder;
  const end = side === "fore" ? t.foreRadius : t.aftRadius;
  return sh.length > 0 && sh.radius > 0 && end > 0 && (t.filled || sh.thickness > 0);
}

/** The part's extent along its axis, shoulders included. */
export function partSpan(part: Part): { min: number; max: number } {
  if (part.kind === "transition") {
    return {
      min: hasShoulder(part, "fore") ? -part.foreShoulder.length : 0,
      max: part.length + (hasShoulder(part, "aft") ? part.aftShoulder.length : 0),
    };
  }
  return { min: 0, max: part.length };
}

/** Outside radius at s: the shoulder's in a shoulder, the profile's in the body. */
export function outerRadiusAt(part: Part, s: number): number {
  if (part.kind === "transition") {
    if (s < 0 && hasShoulder(part, "fore")) return part.foreShoulder.radius;
    if (s > part.length && hasShoulder(part, "aft")) return part.aftShoulder.radius;
    return transitionRadius(part, Math.min(Math.max(s, 0), part.length));
  }
  if (part.kind === "cylinder") return part.outerRadius;
  throw new FeatureError(`details like this can't go on a ${part.type}`);
}

export interface EndFace {
  /** Where the end face is. */
  s: number;
  /** Direction into the part from the face: +1 toward the tail, -1 toward the nose. */
  inward: 1 | -1;
  /** Radius of the face's outside edge, and of any hole through it (0 if solid). */
  radius: number;
  innerRadius: number;
  /** Length of the straight (cylindrical) section ending at this face; 0 if it isn't straight. */
  straight: number;
}

export function endFace(part: Part, end: "fore" | "aft"): EndFace {
  const inward = end === "fore" ? 1 : -1;
  if (part.kind === "transition") {
    const sh = end === "fore" ? part.foreShoulder : part.aftShoulder;
    if (hasShoulder(part, end)) {
      return {
        s: end === "fore" ? -sh.length : part.length + sh.length,
        inward,
        radius: sh.radius,
        innerRadius: part.filled || sh.capped ? 0 : sh.radius - sh.thickness,
        straight: sh.length,
      };
    }
    const s = end === "fore" ? 0 : part.length;
    const radius = transitionRadius(part, s);
    return {
      s,
      inward,
      radius,
      innerRadius: part.filled ? 0 : Math.max(0, radius - part.thickness),
      straight: part.foreRadius === part.aftRadius ? part.length : 0,
    };
  }
  if (part.kind === "cylinder") {
    return { s: end === "fore" ? 0 : part.length, inward, radius: part.outerRadius, innerRadius: part.innerRadius, straight: part.length };
  }
  throw new FeatureError(`details like this can't go on a ${part.type}`);
}

/** Solid all the way through; pockets and nut traps need that. */
export function isSolid(part: Part): boolean {
  return (part.kind === "transition" && part.filled) || (part.kind === "cylinder" && part.innerRadius === 0);
}

/** Where a side hole lands, as a distance from the part's fore end (negative = fore shoulder). */
export function sideHolePosition(part: Part, f: SideHoles): number {
  return f.from === "fore" ? f.at : f.from === "aft" ? part.length - f.at : part.length / 2 + f.at;
}
