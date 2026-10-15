// "@screw-joint": a body tube printed in two pieces that screw together, e.g. a fin section that
// unscrews from the tube above it.
//
// A threaded plug stands up from the aft piece and screws into a threaded collar inside the fore
// piece until the two tube ends meet, so the outside stays one smooth tube. The tube walls are too
// thin to thread, so the collar and plug are added inside, which narrows the inside over the
// joint. Both pieces print standing on their aft ends without supports: the threads have 45°
// flanks, and the collar's top and the plug's base slope at 45°.
//
// Along the axis, from the split (where the tube ends meet) toward the nose:
//   0 .. NECK                    plain neck on the plug, in a counterbore in the collar; with the
//                                detent, two bumps on the neck click into dimples in the counterbore
//   NECK .. NECK + length        the threads
//   .. + RELIEF                  the collar's thread goes on a little, so the plug never bottoms
//   then a 45° slope from the collar out to the tube wall.
// Toward the tail, a ring joins the plug to the aft piece's wall, its underside sloped at 45°.
//
// The pieces are built where they sit with the joint screwed home, as one compound; jointPieces
// sorts them out for files (fore piece first).

import { makeCompound, makeSphere, type AnyShape, type Shape3D } from "replicad";
import type { CylinderPart, Part } from "../ork/model.ts";
import { makeTooth, type ThreadProfile } from "../geometry/thread.ts";
import { polygon, revolveSection } from "../geometry/section.ts";
import type { Frame } from "../geometry/frame.ts";
import { FeatureError, type ScrewJoint } from "./parse.ts";

/** Least plastic outside the collar's thread grooves, and inside the plug's thread, mm. */
const OUTER_WALL = 1.2;
const PLUG_WALL = 2;
/** The plug's plain neck and the counterbore it sits in, mm. */
const NECK = 3;
/** The counterbore is this much wider than the collar's thread grooves, so the plug's thread passes freely. */
const COUNTERBORE_ROOM = 0.1;
/** Lead-in at the counterbore's mouth, mm. */
const MOUTH = 0.3;
/** How far the collar's thread goes past the plug's tip. */
const RELIEF = 1;
/** How far a thread's ridge reaches into the plug's core (or out of the collar) it's joined to, mm. */
const EMBED = 0.2;
/** Gap between a ridge's square end and a face it would otherwise just touch, mm. */
const END_GAP = 0.05;
/** The ring under the plug, joining it to the tube wall: its flat part, mm. */
const BASE = 3;
/** Detent bumps: sphere radius, how far they stand out from the neck, and where along it. */
const BUMP_RADIUS = 1.5;
const BUMP_HEIGHT = 0.3;
const BUMP_AT = 1.3;
/** Dimples are this much bigger than the bumps. */
const DIMPLE_ROOM = 0.05;

/** Where everything goes, in the part's (s, r) coordinates (s from its fore end). */
export interface JointLayout {
  /** The split: where the two tube ends meet. */
  split: number;
  /** Threads: the collar's (cut by this profile) and the plug's. */
  collar: ThreadProfile;
  plug: ThreadProfile;
  /** Inside of the plug, and of the counterbore; the neck's outside. */
  bore: number;
  counterbore: number;
  neck: number;
  /** Fore end of the collar's thread, and of the slope above it (where the joint starts). */
  collarTop: number;
  start: number;
  /** Aft end of the slope under the plug's base ring (where the joint ends). */
  end: number;
}

export function jointLayout(part: Part, f: ScrewJoint): JointLayout {
  if (part.kind !== "cylinder" || part.type !== "bodytube" || part.innerRadius <= 0) {
    throw new FeatureError(`a screw joint goes in a body tube, not a ${part.type}`);
  }
  const R = part.outerRadius;
  const ri = part.innerRadius;
  const L = part.length;
  const split = f.from === "fore" ? f.at : L - f.at;
  const grooves = R - Math.max(R - ri, OUTER_WALL);
  const crestFlat = (f.pitch - 2 * f.depth) / 2;
  const collar: ThreadProfile = { root: grooves - f.depth, crest: grooves, pitch: f.pitch, crestFlat };
  const plug: ThreadProfile = { root: collar.root - f.clearance, crest: collar.crest - f.clearance, pitch: f.pitch, crestFlat };
  const bore = plug.root - PLUG_WALL;
  if (bore < 2) throw new FeatureError(`the tube is too narrow for a thread this deep (the plug would be solid)`);
  const counterbore = grooves + COUNTERBORE_ROOM;
  const collarTop = split - NECK - f.length - RELIEF;
  const start = collarTop - (ri - collar.root);
  const end = split + BASE + (ri - bore);
  if (start <= 0) {
    throw new FeatureError(
      `the joint needs ${fmt(split - start)} mm of tube fore of the split, and there are ${fmt(split)} mm; put it further aft or make length shorter`,
    );
  }
  if (end >= L) {
    throw new FeatureError(`the joint needs ${fmt(end - split)} mm of tube aft of the split, and there are ${fmt(L - split)} mm; put it further fore`);
  }
  return { split, collar, plug, bore, counterbore, neck: counterbore - f.clearance / 2, collarTop, start, end };
}

/**
 * Checks what else is on the tube: anything on the outside that runs across the split would stop
 * it unscrewing (an error); anything inside where the joint narrows the tube gets a warning.
 */
export function checkJoint(part: CylinderPart, j: JointLayout, warnings: string[]): void {
  const x0 = part.instances[0]?.x ?? 0;
  for (const c of part.children) {
    for (const inst of c.instances) {
      const s0 = inst.x - x0;
      const s1 = s0 + c.length;
      const outside = c.kind === "finset" || c.kind === "railbutton" || c.type === "launchlug";
      if (outside) {
        // A rail button's length is 0 here; its base is its outer diameter wide.
        const half = c.kind === "railbutton" ? c.outerDiameter / 2 : 0;
        if (s0 - half < j.split - 1e-9 && s1 + half > j.split + 1e-9) {
          throw new FeatureError(
            `"${c.name}" runs across the joint (${fmt(s0 - half)} to ${fmt(s1 + half)} mm along the tube, the split at ${fmt(j.split)} mm), so it couldn't unscrew`,
          );
        }
        continue;
      }
      if (c.kind !== "cylinder" && c.kind !== "transition") continue;
      const reach = Math.hypot(inst.y, inst.z) + (c.kind === "cylinder" ? c.outerRadius : Math.max(c.foreRadius, c.aftRadius));
      if (s0 < j.end && s1 > j.start && reach > j.bore) {
        warnings.push(
          `${part.name}: "${c.name}" (${fmt(s0)} to ${fmt(s1)} mm along the tube) is in the way of the screw joint, ` +
            `which narrows the inside to ${fmt(2 * j.bore)} mm from ${fmt(j.start)} to ${fmt(j.end)} mm; move the joint (at=) or the ${c.name}.`,
        );
        break;
      }
    }
  }
}

/** The tube in its two pieces, screwed together, as a compound (fore piece first). */
export function buildJointTube(part: CylinderPart, f: ScrewJoint, frame: Frame, angle: number, warnings: string[]): Shape3D {
  const j = jointLayout(part, f);
  checkJoint(part, j, warnings);
  const R = part.outerRadius;
  const ri = part.innerRadius;
  const L = part.length;
  const s = j.split;
  // Threads and bumps are made around the Z axis with z = height above the split, then put in place.
  const place = (shape: Shape3D) => shape.translate([frame.cx, frame.cy, frame.ztop - s]);

  // Fore piece: the tube, the slope down to the collar, the collar and the counterbore; then the
  // collar's thread groove, which starts in the counterbore so the plug's thread can find it.
  let fore: Shape3D = revolveSection(
    polygon([
      [0, ri],
      [0, R],
      [s, R],
      [s, j.counterbore + MOUTH],
      [s - MOUTH, j.counterbore],
      [s - NECK, j.counterbore],
      [s - NECK, j.collar.root],
      [j.collarTop, j.collar.root],
      [j.start, ri],
    ]),
    frame,
  );
  const groove = makeTooth(j.collar, j.collar.root - EMBED, 0, s - j.collarTop - END_GAP);
  if (groove) fore = fore.cut(place(groove));

  // Aft piece: the plug's core and neck, the ring under them and the tube; then the plug's thread.
  let aft: Shape3D = revolveSection(
    polygon([
      [j.collarTop + RELIEF, j.bore],
      [j.collarTop + RELIEF, j.plug.root],
      [s - NECK, j.plug.root],
      [s - NECK, j.neck],
      [s, j.neck],
      [s, R],
      [L, R],
      [L, ri],
      [j.end, ri],
      [s + BASE, j.bore],
    ]),
    frame,
  );
  const ridge = makeTooth(j.plug, j.plug.root - EMBED, NECK, NECK + f.length - END_GAP);
  if (!ridge) throw new FeatureError("length is too short for even one turn of thread");
  aft = aft.fuse(place(ridge));

  if (f.detent) {
    // Two bumps opposite each other, so the plug squeezes evenly as they ride in.
    const centre = j.neck + BUMP_HEIGHT - BUMP_RADIUS;
    for (const k of [0, 1]) {
      const a = angle + f.angle + k * Math.PI;
      const at: [number, number, number] = [centre * Math.cos(a), centre * Math.sin(a), BUMP_AT];
      aft = aft.fuse(place(makeSphere(BUMP_RADIUS).translate(at)));
      fore = fore.cut(place(makeSphere(BUMP_RADIUS + DIMPLE_ROOM).translate(at)));
    }
  }
  return makeCompound([fore, aft]) as Shape3D;
}

/** A built joint tube's two pieces, fore first (by where they are along the axis). */
export function jointPieces(shape: AnyShape): Shape3D[] {
  const solids = "solids" in shape ? (shape as Shape3D).solids : [];
  return [...solids].sort((a, b) => b.boundingBox.center[2] - a.boundingBox.center[2]);
}

function fmt(v: number): string {
  return String(Number(v.toFixed(2)));
}
