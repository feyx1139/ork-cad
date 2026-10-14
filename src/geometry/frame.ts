// The CAD frame (mm), the same as OpenRocket's default OBJ export: Z is the rocket axis with the
// tail at Z = 0 and the nose tip at Z = rocket length; X and Y are OpenRocket's y and z.

import type { Instance, RocketModel } from "../ork/model.ts";

/** (s, r): s = distance from a part's fore end toward the tail, r = distance from its axis. */
export type P2 = [number, number];

/** Where a part's cross-section goes: Z of its fore end and the position of its axis. */
export interface Frame {
  ztop: number;
  cx: number;
  cy: number;
}

export function frameFor(model: RocketModel, inst: Instance): Frame {
  return { ztop: model.length - inst.x, cx: inst.y, cy: inst.z };
}

/** A cross-section point, in the plane through the part's axis at angle 0. */
export function at3(f: Frame, [s, r]: P2): [number, number, number] {
  return [f.cx + r, f.cy, f.ztop - s];
}
