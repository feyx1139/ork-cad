// Details ork-cad adds by itself, worked out from the design, so printed parts come out ready to
// fly without typing them in. Each is an ordinary detail line with the reason it was added; a line
// of the same kind written in the comment replaces it, and "@auto off" (or "@auto vents=off",
// "@auto solid=off", "@auto pocket=off", "@auto nut-trap=off", "@auto edges=off",
// "@auto one-piece=off") in a part's comment turns them off.
//
//  - vents: holes into the altimeter's sealed space, so it senses the outside air pressure. Four
//    in a ring, 90 degrees apart (the American Rocketry Challenge handbook: four is best, never
//    two, all the same size); sized for the space's volume by PerfectFlite's rule; on a straight,
//    smooth part of the outside, well behind the nose cone, near the altimeter, turned so nothing
//    sticking out of the rocket ahead of them is in line with one. None if the space already has
//    vents of your own; "@auto vents=off" on a part keeps them off that part.
//  - solid: a printed nose cone or transition that OpenRocket has hollow, but whose material has an
//    infill's density (so it's printed solid with infill anyway), is printed solid when its
//    altimeter pocket or eyebolt nut needs that.
//  - pocket: when OpenRocket has the altimeter inside a solid printed nose cone or transition, a
//    square pocket for it from the end away from the ejection charge, with a rounded mouth.
//  - nut-trap: when the shock cord sits next to an end of a solid printed nose cone or
//    transition, a captive nut there for an M4 eyebolt, so the eyebolt can't work loose.
//  - edges: the free end of each shoulder of a printed nose cone or transition gets a lead-in, so
//    it slides into its tube: a chamfer on the end it's printed standing on, a round on the other.
//  - one-piece: printed fins on a printed body tube are printed as part of it, their roots joined
//    into its wall, unless they have tabs (which are for gluing into slots).

import { allParts, isFilled, type FinSetPart, type Part, type RocketModel, type TransitionPart } from "../ork/model.ts";
import { PRINTED } from "../export/colors.ts";
import { findCompartments, isAltimeter, type Compartment } from "../checks/compartments.ts";
import { hasShoulder, outerRadiusAt, partSpan } from "./part-shape.ts";
import { NUT_ROOM, nutSize } from "./hardware.ts";
import { parseFeatures, type AutoKind } from "./parse.ts";

/** Room around the altimeter in its pocket: each side, and past its far end (mm). */
const POCKET_ROOM = { side: 0.5, end: 3 };
/** Plastic kept around a pocket, under it, and between it and the eyebolt's screw hole (mm). */
const POCKET_WALL = 2;
const FLOOR = 3;
/** How far a pocket reaches past the middle of a band, so vents through the band open into it (mm). */
const VENT_REACH = 3;
/** Four vents, and the smallest: 0.02", the ARC handbook's size for most ARC rockets (mm). */
const VENT_COUNT = 4;
const MIN_VENT = 0.508;
/** Vents go at least this many body diameters behind the nose cone (PerfectFlite: 4 to 5). */
const NOSE_CALIBRES = 4;
/** And this far from where a tube starts or ends, or from a coupler or shoulder inside it (mm). */
const JOINT_GAP = 10;
/** Plastic lighter than this is a printing infill, kg/m³: no printing plastic is that light solid (PLA is 1240). */
const INFILL_DENSITY = 800;
/** The eyebolt: its screw size, and the plastic between the end and its nut (mm). */
const EYEBOLT = "M4";
const EYEBOLT_DEPTH = 12;

/**
 * Works out the automatic details of every part and adds them to its features (marked `auto`),
 * after taking out any it had before. Call it again after changing a part's comment.
 */
export function addAutoDetails(model: RocketModel): void {
  const parts = allParts(model);
  for (const p of parts) {
    p.features = p.features.filter((f) => !f.auto);
    p.autoNotes = [];
  }
  for (const p of parts) if (p.kind === "finset") onePiece(model, p);
  const transitions = parts.filter((p): p is TransitionPart => p.kind === "transition");
  const wantSolid = new Map<TransitionPart, string[]>();
  solid(model, transitions);
  for (const p of transitions) edges(p);
  const before = findCompartments(model).compartments;
  for (const p of transitions) pocket(model, p, before, wantSolid);
  // Pockets open solid parts up, so the sealed spaces are worked out again.
  const spaces = findCompartments(model).compartments;
  for (const p of transitions) nutTrap(model, p, spaces, wantSolid);
  for (const [p, what] of wantSolid) {
    note(
      p,
      `${p.name} is hollow in OpenRocket, so ork-cad can't give it ${what.join(" or ")}. Tick "Filled" for it in ` +
        `OpenRocket (and set its material to your infill's density, so the mass stays right) and it will.`,
    );
  }
  vents(model, spaces);
}

// ---------------------------------------------------------------------------------------------
// One piece

/**
 * Printed fins on a printed body tube are printed with it, as one piece: nothing to glue or line
 * up, and a canted fin comes out at its angle. Not when the fins have tabs: those go through slots
 * in the tube, to be glued in.
 */
function onePiece(model: RocketModel, p: FinSetPart): void {
  if (!on(p, "one-piece") || p.features.some((f) => f.kind === "one-piece") || p.tab) return;
  const tube = allParts(model).find((q) => q.children.includes(p));
  if (!tube || tube.kind !== "cylinder" || tube.type !== "bodytube" || tube.innerRadius <= 0) return;
  if (!printed(p) || !printed(tube)) return;
  const density = (q: Part) => Number(q.node?.fields.get("material")?.attrs.density);
  const mass =
    density(p) !== density(tube)
      ? ` The file's plastic is all counted at ${tube.name}'s material (${density(tube)} kg/m³) in the report; the fins' own (${density(p)} kg/m³) is what OpenRocket uses for them.`
      : "";
  add(
    p,
    "@one-piece",
    `Printed as part of ${tube.name}, in its file: both are printed (${materialName(p)}, ${materialName(tube)}) and the fins have no tabs, ` +
      `so they aren't meant to be glued into slots. Each fin's root reaches into the tube's wall and is joined to it${p.cant !== 0 ? ", at the fins' cant" : ""}. ` +
      `Turn this off to print the fins on their own.${mass}`,
  );
}

function materialName(p: Part): string {
  return p.node?.fields.get("material")?.text ?? "no material";
}

// ---------------------------------------------------------------------------------------------
// Solid

/**
 * Printed solid, when OpenRocket has a printed nose cone or transition hollow but its material has
 * an infill's density, so it's printed solid with infill anyway (OpenRocket's wall only gets its
 * mass about right), and the altimeter's pocket or the eyebolt's nut needs solid plastic. A part
 * of solid plastic stays hollow: its thin wall is meant. Every part that could be is tried solid at
 * once, since a solid part splits the spaces around it (a hollow transition can join the shock
 * cord's space to a nose cone's).
 */
function solid(model: RocketModel, transitions: TransitionPart[]): void {
  const tried = transitions.flatMap((p) => {
    if (!printed(p) || p.filled || !on(p, "solid") || p.features.some((f) => f.kind === "solid")) return [];
    const material = p.node?.fields.get("material");
    const density = Number(material?.attrs.density);
    if (!(density > 0 && density < INFILL_DENSITY)) return [];
    add(p, "@solid", "?");
    return [{ p, because: `its material (${material?.text}, ${density} kg/m³) has an infill's density, so it's printed solid with that infill anyway` }];
  });
  if (!tried.length) return;
  const spaces = findCompartments(model).compartments;
  for (const { p, because } of tried) {
    const needs: string[] = [];
    const alt = on(p, "pocket") ? altimeterIn(model, p) : undefined;
    if (alt) needs.push(`a pocket for the altimeter (${alt.part.name})`);
    const cord = on(p, "nut-trap") ? cordAt(p, spaces) : undefined;
    if (cord) needs.push(`a captive nut for the eyebolt the shock cord (${cord.cord.name}) ties to`);
    const f = p.features.find((x) => x.kind === "solid" && x.auto)!;
    if (!needs.length) {
      p.features = p.features.filter((x) => x !== f);
      continue;
    }
    const wall = p.thickness > 0 ? `, with a ${mm(p.thickness)} mm wall` : "";
    f.auto =
      `Printed solid: OpenRocket has ${p.name} hollow${wall}, but ${needs.join(" and ")} need${needs.length === 1 ? "s" : ""} solid plastic, ` +
      `and ${because}. OpenRocket still works out its mass as hollow; tick "Filled" for it there too (or keep a mass override) so the ` +
      `simulation has the printed mass. Turn this off and it stays hollow, without them.`;
  }
}

// ---------------------------------------------------------------------------------------------
// Edges

/** Lead-ins on the free ends of a printed part's shoulders, so they slide into their tubes. */
function edges(p: TransitionPart): void {
  if (!printed(p) || !on(p, "edges")) return;
  const endRadius = (end: "fore" | "aft") =>
    end === "fore" ? (hasShoulder(p, "fore") ? p.foreShoulder.radius : p.foreRadius) : hasShoulder(p, "aft") ? p.aftShoulder.radius : p.aftRadius;
  // It's printed standing on its wider end (the aft one if they're the same).
  const bed = endRadius("fore") > endRadius("aft") ? "fore" : "aft";
  for (const end of ["fore", "aft"] as const) {
    if (!hasShoulder(p, end)) continue;
    if (p.features.some((f) => (f.kind === "chamfer" || f.kind === "round") && f.end === end)) continue;
    const sh = end === "fore" ? p.foreShoulder : p.aftShoulder;
    // In by 5% of the shoulder's diameter, at most 4 mm; on a hollow shoulder at most half its wall.
    const wall = isFilled(p) ? Infinity : sh.thickness;
    let inset = Math.floor(Math.min(4, 0.1 * sh.radius) * 10 + 1e-9) / 10;
    const thin = wall / 2 < inset;
    if (thin) inset = Math.floor((wall / 2) * 10 + 1e-9) / 10;
    if (inset < 0.3) continue;
    const name = `the ${end} shoulder`;
    const ofWall = thin ? ` (half the ${mm(wall)} mm wall)` : "";
    if (end !== bed) {
      add(
        p,
        `@round end=${end} radius=${mm(inset)}`,
        `Rounded rim on the end of ${name}, ${mm(inset)} mm${ofWall}, so it slides into its tube without catching. ` +
          `This end is the top of the print, where a round prints cleanly.`,
      );
      continue;
    }
    if (wall < 3 * inset) {
      add(
        p,
        `@chamfer end=${end} inset=${mm(inset)} angle=45`,
        `Lead-in on the end of ${name}: a 45° chamfer ${mm(inset)} mm in${ofWall}, so it slides into its tube. ` +
          `The part is printed standing on this end, and a chamfer there needs no support.`,
      );
      continue;
    }
    // A 30 degree lead-in, its start rounded so there's no edge to catch; shorter on a short shoulder.
    const angle = Math.PI / 6;
    let round = 1.5 * inset;
    const length = (i: number, r: number) => r * Math.sin(angle) + (i - r * (1 - Math.cos(angle))) / Math.tan(angle);
    const scale = Math.min(1, sh.length / 2 / length(inset, round));
    inset = Math.floor(inset * scale * 10 + 1e-9) / 10;
    round = Math.floor(round * scale * 10 + 1e-9) / 10;
    if (inset < 0.3) continue;
    add(
      p,
      `@chamfer end=${end} inset=${mm(inset)} angle=30 round=${mm(round)}`,
      `Lead-in on the end of ${name}: a 30° chamfer ${mm(inset)} mm in, blended into the side with a ${mm(round)} mm round, ` +
        `so the shoulder finds its way into the tube and centres itself. The part is printed standing on this end, ` +
        `and a chamfer there needs no support where a round would overhang.`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Altimeter pocket

interface Placed {
  part: Part;
  /** Fore end, mm from the nose tip, length and radius (mm). */
  x: number;
  length: number;
  radius: number;
}

/** A pocket for the altimeter, when OpenRocket has it inside this part. */
function pocket(model: RocketModel, p: TransitionPart, spaces: Compartment[], wantSolid: Map<TransitionPart, string[]>): void {
  if (!printed(p) || !on(p, "pocket") || p.features.some((f) => f.kind === "pocket")) return;
  const alt = altimeterIn(model, p);
  if (!alt) return;
  if (!isFilled(p)) {
    wantSolid.set(p, [...(wantSolid.get(p) ?? []), `a pocket for the altimeter (${alt.part.name})`]);
    return;
  }
  if (alt.radius <= 0) {
    note(p, `${alt.part.name} (the altimeter) has no size in OpenRocket, so there's no pocket for it: give it a radius and length.`);
    return;
  }
  const x0 = p.instances[0].x;
  const span = partSpan(p);
  const faceAt = { fore: x0 + span.min, aft: x0 + span.max };
  const ejection = (end: "fore" | "aft") => spaceAt(spaces, end === "fore" ? faceAt.fore - 0.01 : faceAt.aft + 0.01)?.ejection ?? false;
  const middle = alt.x + alt.length / 2;
  // A nose cone only has its base to open at. Otherwise not toward the ejection charge if it can
  // help it, and then the end nearer the altimeter.
  const ends = p.type === "nosecone" ? (["aft"] as const) : (["fore", "aft"] as const);
  const away = ends.filter((e) => !ejection(e));
  const end = [...(away.length ? away : ends)].sort((a, b) => Math.abs(faceAt[a] - middle) - Math.abs(faceAt[b] - middle))[0];
  const face = faceAt[end];
  const why =
    p.type === "nosecone" ? "its base" : away.length === 1 && ends.length === 2 ? "away from the motor's ejection charge" : "the end nearer the altimeter";

  // Deep enough for the altimeter where OpenRocket has it, and past the middle of the band if
  // there is one, so vents through the band open into the pocket.
  const far = end === "fore" ? alt.x + alt.length - face : face - alt.x;
  let depth = Math.max(5, far + POCKET_ROOM.end);
  const band = p.type === "transition" && p.foreRadius === p.aftRadius && p.length > 0 && on(p, "vents") && !p.features.some((f) => f.kind === "side-holes");
  const toBand = Math.abs(x0 + p.length / 2 - face) + VENT_REACH;
  if (band) depth = Math.max(depth, toBand);
  const most = span.max - span.min - FLOOR;
  if (depth > most) {
    note(p, `The altimeter's pocket would need to be ${mm(depth)} mm deep, but ${p.name} is only ${mm(span.max - span.min)} mm long; it's made ${mm(most)} mm deep.`);
    depth = most;
  }
  depth = Math.round(depth * 10) / 10;

  // Square, so a box-shaped altimeter fits, with a little room.
  const side = Math.ceil((2 * alt.radius + 2 * POCKET_ROOM.side) * 2 - 1e-9) / 2;
  const reach = side / Math.SQRT2;
  const s0 = end === "fore" ? span.min : span.max - depth;
  const s1 = end === "fore" ? span.min + depth : span.max;
  const outside = Math.min(...Array.from({ length: 41 }, (_, i) => outerRadiusAt(p, s0 + ((s1 - s0) * i) / 40)));
  if (outside - reach < POCKET_WALL) {
    note(p, `${alt.part.name} (the altimeter) is too big for a pocket in ${p.name}: a ${mm(side)} mm square pocket would leave ${mm(outside - reach)} mm of wall.`);
    return;
  }
  // A rounded mouth guides the altimeter in: a fifth of the pocket's width, at most 4 mm, keeping
  // clear of the lead-in on that end.
  const rim = outerRadiusAt(p, end === "fore" ? span.min : span.max) - edgeInset(p, end);
  const round = Math.max(0, Math.min(4, Math.floor(side * 0.2 * 2) / 2, Math.floor((rim - reach - POCKET_WALL) * 2) / 2));
  add(
    p,
    `@pocket size=${mm(side)}x${mm(side)} depth=${mm(depth)} end=${end}${round > 0 ? ` round=${mm(round)}` : ""}`,
    `Altimeter pocket: OpenRocket has ${alt.part.name} (${mm(2 * alt.radius)} mm across, ${mm(alt.length)} mm long) inside ${p.name}. ` +
      `It's square so a box-shaped altimeter fits, with ${POCKET_ROOM.side} mm room each side, and ${mm(depth)} mm deep: ` +
      `${POCKET_ROOM.end} mm past where the altimeter ends` +
      (band && toBand >= far + POCKET_ROOM.end ? `, and past the middle of the band so vents through the band open into it` : "") +
      `. It opens at the ${end} end (${why}), so the altimeter comes out after each flight for the official reading` +
      (round > 0 ? `, and its mouth is rounded (${mm(round)} mm) to guide the altimeter in.` : "."),
  );
}

/** The altimeter most inside the part (more than 1 mm), if OpenRocket puts one there. */
function altimeterIn(model: RocketModel, p: TransitionPart): Placed | undefined {
  const span = partSpan(p);
  const [a, b] = [p.instances[0].x + span.min, p.instances[0].x + span.max];
  let best: Placed | undefined;
  let most = 1;
  for (const q of allParts(model)) {
    if (q.kind !== "other" || q.type !== "masscomponent" || !isAltimeter(q)) continue;
    for (const inst of q.instances) {
      const overlap = Math.min(b, inst.x + q.length) - Math.max(a, inst.x);
      if (overlap > most) {
        most = overlap;
        best = { part: q, x: inst.x, length: q.length, radius: packedRadius(q) };
      }
    }
  }
  return best;
}

/** A mass component's radius, mm ("auto 0.0325" when it fills its tube). */
function packedRadius(q: Part): number {
  const m = /(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s*$/i.exec(q.node?.fields.get("packedradius")?.text ?? "");
  return m ? Number(m[1]) * 1000 : 0;
}

// ---------------------------------------------------------------------------------------------
// Eyebolt nut trap

/** A captive nut for the eyebolt the shock cord is tied to, at the end the cord is next to. */
function nutTrap(model: RocketModel, p: TransitionPart, spaces: Compartment[], wantSolid: Map<TransitionPart, string[]>): void {
  if (!printed(p) || !on(p, "nut-trap") || p.features.some((f) => f.kind === "nut-trap")) return;
  const span = partSpan(p);
  const at = cordAt(p, spaces);
  if (!at) return;
  const { end, cord } = at;
  const sh = end === "fore" ? p.foreShoulder : p.aftShoulder;
  if (!isFilled(p)) {
    // A capped hollow shoulder takes an eyebolt with its nut on the inside, no trap needed.
    if (!sh.capped) wantSolid.set(p, [...(wantSolid.get(p) ?? []), `a captive nut for the eyebolt the shock cord (${cord.name}) ties to`]);
    return;
  }
  if (p.features.some((f) => f.kind === "pocket" && f.end === end)) {
    note(p, `The shock cord (${cord.name}) is next to the ${end} end, but the altimeter pocket opens there, so there's no room for an eyebolt in the middle of it.`);
    return;
  }
  const nut = nutSize(EYEBOLT)!;
  const thickness = nut.thickness + NUT_ROOM.thickness;
  // The screw hole goes 3 mm past the nut (the nut-trap default); keep plastic between it and
  // a pocket from the other end.
  const length = span.max - span.min;
  const other = p.features.find((f) => f.kind === "pocket" && f.end !== end);
  const room = (other && other.kind === "pocket" ? length - other.depth - POCKET_WALL : length - FLOOR) - 3 - nut.hole / 2;
  const depth = Math.floor(Math.min(EYEBOLT_DEPTH, sh.length - thickness - 3, room - thickness) * 10) / 10;
  if (depth < 5) {
    note(p, `The shock cord (${cord.name}) is next to the ${end} end, but there's no room there for a captive eyebolt nut.`);
    return;
  }
  const bolt = depth + thickness + 3;
  add(
    p,
    `@nut-trap size=${EYEBOLT} depth=${mm(depth)} end=${end}`,
    `Eyebolt anchor: the shock cord (${cord.name}) is next to the ${end} end, so an ${EYEBOLT} eyebolt screws in through the end ` +
      `into a nut held in a hex pocket ${mm(depth)} mm in. The nut goes in through the slot in the side of the shoulder, which the tube ` +
      `covers once the rocket is together, so the nut can't turn or fall out and the eyebolt can't work loose. ` +
      `The screw hole is ${mm(bolt)} mm deep; the eyebolt needs at least ${mm(depth + nut.thickness)} mm of thread.`,
  );
}

/** The end with a shoulder that the shock cord sits next to (the aft one first), if any. */
function cordAt(p: TransitionPart, spaces: Compartment[]): { end: "fore" | "aft"; cord: Part } | undefined {
  const x0 = p.instances[0].x;
  const span = partSpan(p);
  for (const end of ["aft", "fore"] as const) {
    // The nut goes in through a slot in the side, which the tube over a shoulder keeps closed.
    if (!hasShoulder(p, end)) continue;
    const face = end === "fore" ? x0 + span.min : x0 + span.max;
    const cord = spaceAt(spaces, end === "fore" ? face - 0.01 : face + 0.01)?.contents.find((q) => q.type === "shockcord");
    if (cord) return { end, cord };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Vents

/** Vent holes into each sealed space with an altimeter in it that has none. */
function vents(model: RocketModel, spaces: Compartment[]): void {
  for (const c of spaces) {
    if (!c.altimeter || c.vents.length) continue;
    const alt = c.contents.find(isAltimeter)!;
    const altInst = alt.instances.find((i) => c.from - 1e-6 <= i.x + alt.length / 2 && i.x + alt.length / 2 <= c.to + 1e-6) ?? alt.instances[0];
    const middle = altInst.x + alt.length / 2;
    // Size: PerfectFlite's single static port is 0.0016 * D^2 * L inches for a D x L inch bay
    // (that is, 0.0016 * 4V/pi for V cubic inches); four ports are each half that.
    const cubicInches = c.volume / 16387.064;
    const single = (0.0016 * 4 * cubicInches) / Math.PI;
    const diameter = Math.max(0.5, Math.round(Math.max(MIN_VENT, (single / 2) * 25.4) * 10) / 10);
    // Nowhere straight and uncovered opens into the space: the sealed-space check warns about it.
    const spot = ventSpot(model, c, middle, diameter / 2);
    if (!spot) continue;
    const angle = ventAngle(model, spot.x);
    const at = spot.x - spot.part.instances[0].x;
    add(
      spot.part,
      `@side-holes count=${VENT_COUNT} diameter=${mm(diameter)} at=${mm(at)} angle=${angle}`,
      `Altimeter vents (static ports) into the sealed space with ${alt.name}: the altimeter works out its height from the air ` +
        `pressure, so its space needs small holes to the outside. Four, 90° apart in one ring: the American Rocketry Challenge ` +
        `handbook says four is best (never two), all the same size and evenly spaced, so wind from one side averages out. ` +
        `${mm(diameter)} mm across: the space holds ${round1(c.volume / 1000)} cm³ (${round1(cubicInches)} in³) of air, and for that ` +
        `PerfectFlite's rule is one ${inches(single)}" hole or four ${inches(single / 2)}" ones` +
        (single / 2 < MIN_VENT / 25.4 ? `, smaller than the 0.02" (0.5 mm) the handbook gives for most ARC rockets, so 0.5 mm` : "") +
        `. Bigger holes add wind noise, and a spike at ejection that can spoil the apogee reading. ` +
        `${mm(at)} mm from the fore end of ${spot.part.name}${spot.band ? " (the middle of its band)" : ""}: on a straight, smooth ` +
        `part of the outside${spot.calibres ? `, at least ${NOSE_CALIBRES} body diameters behind the nose cone` : ""}, as near the ` +
        `altimeter as that allows, and turned to ${angle}° so nothing sticking out of the rocket ahead of them ` +
        `(launch lug, rail buttons, fins) is in line with one.` +
        (spot.calibres || !spot.nose
          ? ""
          : ` They're closer behind the nose cone than the ${NOSE_CALIBRES} body diameters PerfectFlite advises: there's no straight part further back.`),
    );
  }
}

interface Spot {
  part: Part;
  /** Where the ring of vents goes, mm from the nose tip. */
  x: number;
  band: boolean;
  /** Far enough behind the nose cone (if the rocket has one). */
  calibres: boolean;
  nose: boolean;
}

/**
 * Where the vents for a space go: on a straight piece of the outside (a body tube, or the band of
 * a transition the same size at both ends) that isn't covered on the inside by a shoulder or
 * coupler, that opens into the space, clear of joints, and as near the altimeter as possible.
 */
function ventSpot(model: RocketModel, c: Compartment, middle: number, r: number): Spot | undefined {
  const bodies = model.stages.flatMap((s) => s.children);
  const runs: { part: Part; from: number; to: number; band: boolean }[] = [];
  bodies.forEach((b, i) => {
    const x0 = b.instances[0].x;
    if (!on(b, "vents")) return; // "@auto vents=off": none on this part
    if (b.kind === "cylinder" && b.type === "bodytube") {
      // What sits inside the tube: the shoulders of its neighbours (even ones OpenRocket gives no
      // wall, which ork-cad leaves out but the real part will have), and couplers.
      const covered: [number, number][] = [];
      const prev = bodies[i - 1];
      const next = bodies[i + 1];
      const declared = (t: Part | undefined, side: "fore" | "aft") =>
        t?.kind === "transition" && (side === "fore" ? t.foreShoulder : t.aftShoulder).length > 0 && (side === "fore" ? t.foreShoulder : t.aftShoulder).radius > 0;
      if (declared(prev, "aft")) covered.push([x0, x0 + (prev as TransitionPart).aftShoulder.length]);
      if (declared(next, "fore")) covered.push([x0 + b.length - (next as TransitionPart).foreShoulder.length, x0 + b.length]);
      for (const k of b.children) {
        if (k.kind === "cylinder" && k.type === "tubecoupler") for (const inst of k.instances) covered.push([inst.x, inst.x + k.length]);
      }
      for (const [from, to] of uncovered(x0, x0 + b.length, covered)) runs.push({ part: b, from, to, band: false });
    } else if (b.kind === "transition" && b.type === "transition" && b.foreRadius === b.aftRadius && b.length > 0) {
      runs.push({ part: b, from: x0, to: x0 + b.length, band: true });
    }
  });
  const nose = bodies[0]?.kind === "transition" && bodies[0].type === "nosecone" ? bodies[0] : undefined;
  const behind = nose ? nose.instances[0].x + nose.length + NOSE_CALIBRES * 2 * nose.aftRadius : -Infinity;
  const spots = (needCalibres: boolean): Spot[] =>
    runs.flatMap((run) => {
      // Clear of the joints at its ends, inside the space, and far enough behind the nose.
      const gap = Math.min((run.to - run.from) / 2, JOINT_GAP);
      const lo = Math.max(run.from + gap, c.from + r + 1, needCalibres ? behind : -Infinity);
      const hi = Math.min(run.to - gap, c.to - r - 1);
      if (lo > hi + 1e-9) return [];
      return [{ part: run.part, x: Math.min(Math.max(middle, lo), hi), band: run.band, calibres: needCalibres, nose: nose !== undefined }];
    });
  const found = spots(true).length ? spots(true) : spots(false);
  return found.sort((a, b) => Math.abs(a.x - middle) - Math.abs(b.x - middle) || Number(printed(b.part)) - Number(printed(a.part)))[0];
}

/** A run with the covered pieces taken out. */
function uncovered(from: number, to: number, covered: [number, number][]): [number, number][] {
  let runs: [number, number][] = [[from, to]];
  for (const [a, b] of covered) {
    runs = runs.flatMap(([x, y]): [number, number][] => {
      if (b <= x || a >= y) return [[x, y]];
      const out: [number, number][] = [];
      if (a > x) out.push([x, a]);
      if (b < y) out.push([b, y]);
      return out;
    });
  }
  return runs.filter(([x, y]) => y - x > 1e-6);
}

/**
 * Which way the first of the four vents faces (degrees, 0 = the first fin): as far as possible
 * from launch lugs, rail buttons and fins ahead of the vents (the handbook: nothing sticking out
 * in line with and ahead of a vent), then from the fins behind them, for looks.
 */
function ventAngle(model: RocketModel, x: number): number {
  const ahead: number[] = [];
  const behind: number[] = [];
  for (const q of allParts(model)) {
    const sticksOut = q.kind === "railbutton" || q.kind === "finset" || (q.kind === "cylinder" && q.type === "launchlug");
    if (!sticksOut) continue;
    for (const inst of q.instances) (inst.x < x ? ahead : behind).push((inst.angle * 180) / Math.PI);
  }
  const step = 360 / VENT_COUNT;
  const gap = (a: number, list: number[]) =>
    list.length ? Math.min(...list.map((o) => Math.abs((((o - a) % step) + 1.5 * step) % step - step / 2))) : step / 2;
  let best = 0;
  let bestScore = -Infinity;
  for (let a = 0; a < step; a++) {
    const score = 1000 * gap(a, ahead) + gap(a, behind) - 0.001 * Math.abs(a - step / 2);
    if (score > bestScore) [best, bestScore] = [a, score];
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Helpers

function printed(p: Part): boolean {
  return PRINTED.test(p.node?.fields.get("material")?.text ?? "");
}

function on(p: Part, kind: AutoKind): boolean {
  return p.autoSettings?.[kind] ?? true;
}

/** Adds an automatic detail, from the line it would be written as. */
function add(part: Part, line: string, why: string): void {
  const { features, errors } = parseFeatures(line);
  if (errors.length || features.length !== 1) throw new Error(`Internal error: automatic detail "${line}": ${errors.join("; ")}`);
  part.features.push({ ...features[0], auto: why });
}

function note(part: Part, text: string): void {
  (part.autoNotes ??= []).push(text);
}

function spaceAt(spaces: Compartment[], x: number): Compartment | undefined {
  return spaces.find((c) => c.from - 1e-6 <= x && x <= c.to + 1e-6);
}

/** How far in the edge treatment at an end cuts, so a rounded pocket mouth keeps clear of it. */
function edgeInset(p: Part, end: "fore" | "aft"): number {
  let inset = 0;
  for (const f of p.features) {
    if (f.kind === "round" && f.end === end) inset = Math.max(inset, f.radius);
    if (f.kind === "chamfer" && f.end === end) {
      inset = Math.max(inset, f.round * (1 - Math.cos(f.angle)) + (f.length - f.round * Math.sin(f.angle)) * Math.tan(f.angle));
    }
  }
  return inset;
}

function mm(v: number): string {
  return String(Number(v.toFixed(2)));
}

function round1(v: number): string {
  return String(Number(v.toFixed(1)));
}

/** Inches the way drill sizes are written: .052 */
function inches(v: number): string {
  return v.toFixed(3).replace(/^0/, "");
}
