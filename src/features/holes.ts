// Side holes and end holes from a part's comment (see parse.ts), as solids to cut out, after
// checking they fit: on the part, not overlapping, big enough to print.

import { makeCylinder, type Shape3D } from "replicad";
import type { Instance, Part, RocketModel } from "../ork/model.ts";
import { FeatureError, type EndHoles, type SideHoles } from "./parse.ts";
import { hasShoulder, outerRadiusAt, partSpan, sideHolePosition } from "./part-shape.ts";
import { PRINTED } from "../export/colors.ts";

/** Holes narrower than this (mm) tend to close up when 3D printed; sideways ones (side holes) sooner. */
const SMALL_HOLE = 1;
const SMALL_SIDE_HOLE = 1.5;
/** How far (mm) the cutting tools reach past the part, so they always cut clean through. */
const MARGIN = 1;

export function sideHoleTools(part: Part, model: RocketModel, inst: Instance, f: SideHoles, warnings: string[]): Shape3D[] {
  if (part.kind !== "transition" && part.kind !== "cylinder") throw new FeatureError(`side holes can't go in a ${part.type}`);
  if (inst.y !== 0 || inst.z !== 0) throw new FeatureError("side holes only work on parts centred on the rocket axis");
  const { min, max } = partSpan(part);
  const outer = (s: number) => outerRadiusAt(part, s);
  const s = sideHolePosition(part, f);
  const r = f.diameter / 2;
  if (s - r < min - 1e-9 || s + r > max + 1e-9) {
    throw new FeatureError(
      `the holes would run off the part: it goes from ${fmt(min)} to ${fmt(max)} mm measured from its fore end, ` +
        `the holes from ${fmt(s - r)} to ${fmt(s + r)} mm`,
    );
  }
  if (f.count > 1 && 2 * outer(s) * Math.sin(Math.PI / f.count) <= f.diameter) {
    throw new FeatureError(`${f.count} holes of ${fmt(f.diameter)} mm don't fit around the part without overlapping`);
  }
  if (f.diameter < SMALL_SIDE_HOLE && PRINTED.test(part.node?.fields.get("material")?.text ?? "")) {
    warnings.push(
      `${part.name}: ${fmt(f.diameter)} mm holes come out smaller than drawn, or closed, when printed running sideways; ` +
        `drill them out to ${fmt(f.diameter)} mm afterwards.`,
    );
  }
  if (
    part.kind === "transition" &&
    ((hasShoulder(part, "fore") && s - r < 0 && s + r > 0) || (hasShoulder(part, "aft") && s - r < part.length && s + r > part.length))
  ) {
    warnings.push(`${part.name}: "${f.source}" sits across the joint between a shoulder and the body.`);
  }
  for (const note of coveredBy(part, model, s - r, s + r)) warnings.push(`${part.name}: "${f.source}": ${note}`);

  // Each hole runs from the part's axis straight out past its outside.
  const reach = Math.max(outer(s - r), outer(s), outer(s + r)) + MARGIN;
  const z = model.length - inst.x - s;
  return Array.from({ length: f.count }, (_, k) => {
    const a = inst.angle + f.angle + (2 * Math.PI * k) / f.count;
    return makeCylinder(r, reach, [inst.y, inst.z, z], [Math.cos(a), Math.sin(a), 0]);
  });
}

/** Notes for holes that another part covers once the rocket is put together. */
function coveredBy(part: Part, model: RocketModel, s0: number, s1: number): string[] {
  const { prev, next } = bodyNeighbours(model, part);
  const notes: string[] = [];
  if (part.kind === "transition") {
    if (s0 < 0 && prev) notes.push(`the fore shoulder sits inside "${prev.name}", so drill matching holes in that`);
    if (s1 > part.length && next) notes.push(`the aft shoulder sits inside "${next.name}", so drill matching holes in that`);
  } else if (part.kind === "cylinder" && part.type === "bodytube") {
    if (prev?.kind === "transition" && hasShoulder(prev, "aft") && s0 < prev.aftShoulder.length) {
      notes.push(`the shoulder of "${prev.name}" sits inside here, so drill matching holes in it`);
    }
    if (next?.kind === "transition" && hasShoulder(next, "fore") && s1 > part.length - next.foreShoulder.length) {
      notes.push(`the shoulder of "${next.name}" sits inside here, so drill matching holes in it`);
    }
  }
  return notes;
}

/** The body components just before and after this one, nose to tail across all stages. */
function bodyNeighbours(model: RocketModel, part: Part): { prev?: Part; next?: Part } {
  const bodies = model.stages.flatMap((s) => s.children);
  const i = bodies.indexOf(part);
  return i < 0 ? {} : { prev: bodies[i - 1], next: bodies[i + 1] };
}

export function endHoleTools(part: Part, model: RocketModel, inst: Instance, f: EndHoles, warnings: string[]): Shape3D[] {
  // The axial span of the cap or plate the holes go through, and the radial room on it.
  let s0: number;
  let s1: number;
  let rMin = 0;
  let rMax: number;
  if (part.kind === "transition") {
    if (part.filled) throw new FeatureError("the part is solid, so end holes through it aren't supported");
    const capped = (["fore", "aft"] as const).filter(
      (side) => hasShoulder(part, side) && (side === "fore" ? part.foreShoulder : part.aftShoulder).capped,
    );
    const end = f.end ?? (capped.length === 1 ? capped[0] : undefined);
    if (!end) {
      throw new FeatureError(
        capped.length ? "both ends are capped; add end=fore or end=aft" : "neither shoulder is capped, so there's no cap for end holes",
      );
    }
    if (!capped.includes(end)) throw new FeatureError(`the ${end} shoulder isn't capped, so there's nothing for end holes to go through`);
    const sh = end === "fore" ? part.foreShoulder : part.aftShoulder;
    [s0, s1] = end === "fore" ? [-sh.length, -sh.length + sh.thickness] : [part.length + sh.length - sh.thickness, part.length + sh.length];
    rMax = sh.radius - sh.thickness;
  } else if (part.kind === "cylinder" && ["bulkhead", "centeringring", "engineblock"].includes(part.type)) {
    [s0, s1] = [0, part.length];
    rMin = part.innerRadius;
    rMax = part.outerRadius;
  } else {
    throw new FeatureError(`end holes go through caps, bulkheads, centering rings and engine blocks, not a ${part.type}`);
  }
  const r = f.diameter / 2;
  if (f.radius - r < rMin - 1e-9 || f.radius + r > rMax + 1e-9) {
    throw new FeatureError(
      rMin > 0
        ? `the holes have to fit between ${fmt(rMin)} and ${fmt(rMax)} mm from the axis`
        : `the holes have to stay within ${fmt(rMax)} mm of the axis, inside the shoulder wall`,
    );
  }
  if (f.count > 1 && 2 * f.radius * Math.sin(Math.PI / f.count) <= f.diameter) {
    throw new FeatureError(`${f.count} holes of ${fmt(f.diameter)} mm overlap at ${fmt(f.radius)} mm from the axis`);
  }
  if (f.diameter < SMALL_HOLE) {
    warnings.push(`${part.name}: ${fmt(f.diameter)} mm holes may close up when printed; drill them out afterwards.`);
  }
  const zBottom = model.length - inst.x - s1 - MARGIN;
  return Array.from({ length: f.count }, (_, k) => {
    const a = inst.angle + f.angle + (2 * Math.PI * k) / f.count;
    const base: [number, number, number] = [inst.y + f.radius * Math.cos(a), inst.z + f.radius * Math.sin(a), zBottom];
    return makeCylinder(r, s1 - s0 + 2 * MARGIN, base, [0, 0, 1]);
  });
}

function fmt(v: number): string {
  return String(Number(v.toFixed(2)));
}
