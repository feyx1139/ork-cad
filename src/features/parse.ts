// Details OpenRocket can't model, written into a component's Comment in OpenRocket, one per line,
// each starting with "@". Everything else in the comment is ignored, so normal notes can stay.
//
//   @side-holes count=4 diameter=2 at=10
//   @end-holes count=4 diameter=3 radius=12 end=fore
//   @pocket size=24x18 depth=40 corner=4 end=fore round=3
//   @nut-trap size=M5 depth=12 end=aft
//   @chamfer end=aft length=6 angle=30 round=3
//   @round end=fore radius=3
//   @solid                    (prints a nose cone or transition solid that OpenRocket has hollow)
//   @auto vents=off           (ork-cad's automatic details, see auto.ts; "@auto off" for none)
//
// Lengths are millimetres unless a unit is given (2.5mm, 0.3cm, 0.1in, 1/8in); angles are degrees.
// Angles around the rocket are measured like OpenRocket's own, so 0 lines up with the first fin.

import { NUT_NAMES, NUT_ROOM, nutSize } from "./hardware.ts";

/** What every detail has: its line, and why ork-cad added it if it wasn't written in (auto.ts). */
interface FeatureBase {
  /** The comment line, for messages. */
  source: string;
  /** Set on details ork-cad adds by itself: why it added this one. */
  auto?: string;
}

export interface SideHoles extends FeatureBase {
  kind: "side-holes";
  count: number;
  diameter: number;
  /** Distance along the rocket axis from `from`, toward the other end; negative goes into a shoulder. */
  at: number;
  from: "fore" | "aft" | "middle";
  /** Angle of the first hole, radians; the rest are spread evenly around. */
  angle: number;
}

/** Holes along the rocket axis, through a cap, bulkhead or ring. */
export interface EndHoles extends FeatureBase {
  kind: "end-holes";
  count: number;
  diameter: number;
  /** Distance of the hole centres from the rocket axis. */
  radius: number;
  /** Which end's cap, for nose cones and transitions; undefined means the only capped one. */
  end?: "fore" | "aft";
  angle: number;
}

/** A cavity cut into a solid part from one end, along the axis (e.g. an altimeter pocket). */
export interface Pocket extends FeatureBase {
  kind: "pocket";
  shape: { kind: "rect"; width: number; height: number; corner: number } | { kind: "round"; diameter: number };
  depth: number;
  end: "fore" | "aft";
  /** Turns the pocket around the axis, radians (the width runs along angle 0). */
  angle: number;
  /** Rounds the edge of the pocket's mouth with this radius, mm (0 = sharp): a lead-in for what goes in. */
  round: number;
}

/** A hex nut held inside a solid part, put in through a slot from the side, with a screw hole along the axis. */
export interface NutTrap extends FeatureBase {
  kind: "nut-trap";
  size: string;
  /** Screw clearance hole diameter, nut pocket width across the flats and pocket thickness, mm. */
  hole: number;
  flats: number;
  thickness: number;
  /** Plastic between the end face and the nut pocket, mm. */
  depth: number;
  /** How far the screw hole goes in from the end face, mm. */
  bolt: number;
  end: "fore" | "aft";
  /** Direction the slot for putting the nut in opens toward, radians. */
  angle: number;
}

/** A chamfer on the outside edge at an end, e.g. a lead-in so a shoulder slides into a tube. */
export interface Chamfer extends FeatureBase {
  kind: "chamfer";
  end: "fore" | "aft";
  /** How far along the axis the chamfer reaches, mm (worked out from `inset` when that's given). */
  length: number;
  /** Angle from the rocket axis, radians (smaller = longer, gentler lead-in). */
  angle: number;
  /** Rounds the start of the chamfer with this radius, mm (0 = sharp). */
  round: number;
}

/** A rounded outside edge at an end. */
export interface Round extends FeatureBase {
  kind: "round";
  end: "fore" | "aft";
  radius: number;
}

/** Built solid, like ticking "Filled" in OpenRocket: for a printed part OpenRocket has hollow. */
export interface Solid extends FeatureBase {
  kind: "solid";
}

export type Feature = SideHoles | EndHoles | Pocket | NutTrap | Chamfer | Round | Solid;

/**
 * The kinds of detail ork-cad can add by itself (see auto.ts). An "@auto" line turns them off or
 * on: "@auto off", "@auto vents=off edges=off".
 */
export const AUTO_KINDS = ["solid", "pocket", "vents", "nut-trap", "edges"] as const;
export type AutoKind = (typeof AUTO_KINDS)[number];
export type AutoSettings = Record<AutoKind, boolean>;

export class FeatureError extends Error {}

const KEYS: Record<Feature["kind"], string[]> = {
  "side-holes": ["count", "diameter", "at", "from", "angle"],
  "end-holes": ["count", "diameter", "radius", "end", "angle"],
  pocket: ["size", "diameter", "depth", "corner", "end", "angle", "round"],
  "nut-trap": ["size", "depth", "end", "angle", "bolt", "hole", "flats", "thickness"],
  chamfer: ["end", "length", "inset", "angle", "round"],
  round: ["end", "radius"],
  solid: [],
};

/**
 * Reads the "@" lines of a comment: the details, and which automatic details are wanted ("@auto"
 * lines; all of them unless a line turns some off). Problems come back as messages naming the line.
 */
export function parseFeatures(comment: string): { features: Feature[]; errors: string[]; auto: AutoSettings } {
  const features: Feature[] = [];
  const errors: string[] = [];
  const auto = Object.fromEntries(AUTO_KINDS.map((k) => [k, true])) as AutoSettings;
  for (const raw of comment.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^@([a-z][a-z-]*)\b(.*)$/i.exec(line);
    if (!m) continue;
    const kind = m[1].toLowerCase() as Feature["kind"];
    try {
      if (m[1].toLowerCase() === "auto") {
        parseAuto(m[2], auto);
        continue;
      }
      if (!(kind in KEYS)) {
        throw new FeatureError(`unknown detail "@${m[1]}" (known: ${[...Object.keys(KEYS), "auto"].map((k) => `@${k}`).join(", ")})`);
      }
      features.push(PARSERS[kind](parseArgs(m[2], KEYS[kind]), line));
    } catch (e) {
      if (!(e instanceof FeatureError)) throw e;
      errors.push(`"${line}": ${e.message}`);
    }
  }
  return { features, errors, auto };
}

/** "@auto off", "@auto on", "@auto vents=off edges=off": applied in order, so later ones win. */
function parseAuto(text: string, auto: AutoSettings): void {
  const tokens = text.split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length) throw new FeatureError(`say what to turn off, e.g. "@auto off" or "@auto vents=off" (${AUTO_KINDS.join(", ")})`);
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq < 0) {
      const on = onOff(token, "@auto");
      for (const k of AUTO_KINDS) auto[k] = on;
      continue;
    }
    const key = token.slice(0, eq).toLowerCase();
    if (!(AUTO_KINDS as readonly string[]).includes(key)) {
      throw new FeatureError(`unknown automatic detail "${key}" (use ${AUTO_KINDS.join(", ")})`);
    }
    auto[key as AutoKind] = onOff(token.slice(eq + 1), key);
  }
}

function onOff(value: string, key: string): boolean {
  if (/^(on|yes|true)$/i.test(value)) return true;
  if (/^(off|no|false)$/i.test(value)) return false;
  throw new FeatureError(`${key} must be on or off (not "${value}")`);
}

type Args = Map<string, string>;

const PARSERS: Record<Feature["kind"], (args: Args, source: string) => Feature> = {
  "side-holes": (args, source) => ({
    kind: "side-holes",
    count: integer(args, "count", 1),
    diameter: positive(args, "diameter"),
    at: lengthArg(args, "at"),
    from: choice(args, "from", ["fore", "aft", "middle"] as const, "fore"),
    angle: angleArg(args, "angle", 0),
    source,
  }),
  "end-holes": (args, source) => {
    const count = integer(args, "count", 1);
    const radius = args.has("radius") ? lengthArg(args, "radius") : 0;
    if (radius < 0) throw new FeatureError("radius can't be negative");
    if (count > 1 && radius === 0) throw new FeatureError("several end holes need a radius, or they'd all be in the middle");
    return {
      kind: "end-holes",
      count,
      diameter: positive(args, "diameter"),
      radius,
      end: args.has("end") ? choice(args, "end", ["fore", "aft"] as const, "fore") : undefined,
      angle: angleArg(args, "angle", 0),
      source,
    };
  },
  pocket: (args, source) => {
    const size = args.get("size");
    if (size !== undefined && args.has("diameter")) throw new FeatureError("give either size (WxH) or diameter, not both");
    let shape: Pocket["shape"];
    if (size !== undefined) {
      const sides = size.split(/[x×]/i);
      if (sides.length !== 2) throw new FeatureError(`size "${size}" should look like 24x18`);
      const [width, height] = sides.map(parseLength);
      const corner = args.has("corner") ? lengthArg(args, "corner") : 0;
      if (width <= 0 || height <= 0) throw new FeatureError("size must be more than 0 both ways");
      if (corner < 0 || corner > Math.min(width, height) / 2) {
        throw new FeatureError(`corner must be between 0 and half the narrower side (${Math.min(width, height) / 2} mm)`);
      }
      shape = { kind: "rect", width, height, corner };
    } else if (args.has("diameter")) {
      if (args.has("corner")) throw new FeatureError("corner only applies to a rectangular pocket (size=WxH)");
      shape = { kind: "round", diameter: positive(args, "diameter") };
    } else {
      throw new FeatureError("give the pocket a size (WxH) or a diameter");
    }
    const round = args.has("round") ? lengthArg(args, "round") : 0;
    if (round < 0) throw new FeatureError("round can't be negative");
    return {
      kind: "pocket",
      shape,
      depth: positive(args, "depth"),
      end: choice(args, "end", ["fore", "aft"] as const, "fore"),
      angle: angleArg(args, "angle", 0),
      round,
      source,
    };
  },
  "nut-trap": (args, source) => {
    const sizeName = args.get("size");
    if (sizeName === undefined) throw new FeatureError(`size is missing (${NUT_NAMES.join(", ")})`);
    const nut = nutSize(sizeName);
    if (!nut) throw new FeatureError(`unknown size "${sizeName}" (known: ${NUT_NAMES.join(", ")})`);
    const thickness = args.has("thickness") ? positive(args, "thickness") : nut.thickness + NUT_ROOM.thickness;
    const depth = positive(args, "depth");
    return {
      kind: "nut-trap",
      size: sizeName,
      hole: args.has("hole") ? positive(args, "hole") : nut.hole,
      flats: args.has("flats") ? positive(args, "flats") : nut.flats + NUT_ROOM.flats,
      thickness,
      depth,
      // By default the screw hole goes 3 mm past the nut, so the screw has room.
      bolt: args.has("bolt") ? positive(args, "bolt") : depth + thickness + 3,
      end: choice(args, "end", ["fore", "aft"] as const, "aft"),
      angle: angleArg(args, "angle", 0),
      source,
    };
  },
  chamfer: (args, source) => {
    const angle = angleArg(args, "angle", Math.PI / 4);
    if (angle <= 0 || angle >= Math.PI / 2) throw new FeatureError("angle must be between 0 and 90 degrees (from the rocket's axis)");
    const round = args.has("round") ? lengthArg(args, "round") : 0;
    if (round < 0) throw new FeatureError("round can't be negative");
    if (args.has("length") && args.has("inset")) throw new FeatureError("give either length or inset, not both");
    let length: number;
    if (args.has("inset")) {
      // How far in it cuts at the end face, as a sketch would dimension it: the round turns in by
      // round * (1 - cos angle), and the straight part covers the rest at `angle` from the axis.
      const inset = positive(args, "inset");
      const turn = round * (1 - Math.cos(angle));
      if (inset < turn - 1e-9) {
        throw new FeatureError(`the round is too big for the inset: on its own it already goes ${Number(turn.toFixed(2))} mm in`);
      }
      length = round * Math.sin(angle) + Math.max(0, inset - turn) / Math.tan(angle);
    } else if (args.has("length")) {
      length = positive(args, "length");
    } else {
      throw new FeatureError("give a length (how far along the axis it goes) or an inset (how far in it cuts at the end)");
    }
    return { kind: "chamfer", end: requiredEnd(args), length, angle, round, source };
  },
  round: (args, source) => ({ kind: "round", end: requiredEnd(args), radius: positive(args, "radius"), source }),
  solid: (_args, source) => ({ kind: "solid", source }),
};

function parseArgs(text: string, allowed: string[]): Args {
  const args: Args = new Map();
  for (const token of text.split(/[\s,;]+/).filter(Boolean)) {
    const eq = token.indexOf("=");
    if (eq <= 0) throw new FeatureError(`"${token}" should look like name=value`);
    const key = token.slice(0, eq).toLowerCase();
    const value = token.slice(eq + 1);
    if (!allowed.includes(key)) throw new FeatureError(`unknown setting "${key}" (use ${allowed.join(", ")})`);
    if (args.has(key)) throw new FeatureError(`"${key}" is given twice`);
    if (!value) throw new FeatureError(`"${key}" has no value`);
    args.set(key, value);
  }
  return args;
}

const NUMBER = String.raw`(-?\d+(?:\.\d+)?|-?\.\d+)`;

/** "2.5", "2.5mm", "0.3cm", "0.1in", "1/8in", "1/8\"" -> millimetres. */
export function parseLength(value: string): number {
  const m = new RegExp(String.raw`^${NUMBER}(?:/${NUMBER})?(mm|cm|m|in|")?$`, "i").exec(value.trim());
  if (!m) throw new FeatureError(`"${value}" isn't a length (try 2.5, 2.5mm or 1/8in)`);
  let v = Number(m[1]);
  if (m[2] !== undefined) v /= Number(m[2]);
  const unit = (m[3] ?? "mm").toLowerCase();
  const scale: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, '"': 25.4 };
  return v * scale[unit];
}

function lengthArg(args: Args, key: string): number {
  const v = args.get(key);
  if (v === undefined) throw new FeatureError(`${key} is missing`);
  return parseLength(v);
}

function positive(args: Args, key: string): number {
  const v = lengthArg(args, key);
  if (v <= 0) throw new FeatureError(`${key} must be more than 0`);
  return v;
}

function angleArg(args: Args, key: string, fallback: number): number {
  const v = args.get(key);
  if (v === undefined) return fallback;
  const m = new RegExp(String.raw`^${NUMBER}(deg|°)?$`, "i").exec(v.trim());
  if (!m) throw new FeatureError(`${key} "${v}" isn't an angle in degrees`);
  return (Number(m[1]) * Math.PI) / 180;
}

function integer(args: Args, key: string, fallback: number): number {
  const v = args.get(key);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new FeatureError(`${key} must be a whole number of 1 or more (not "${v}")`);
  return n;
}

function choice<T extends string>(args: Args, key: string, options: readonly T[], fallback: T): T {
  const v = (args.get(key) ?? fallback).toLowerCase();
  if (!(options as readonly string[]).includes(v)) {
    const list = options.length > 1 ? `${options.slice(0, -1).join(", ")} or ${options[options.length - 1]}` : options[0];
    throw new FeatureError(`${key} must be ${list} (not "${v}")`);
  }
  return v as T;
}

function requiredEnd(args: Args): "fore" | "aft" {
  if (!args.has("end")) throw new FeatureError("end is missing (fore or aft)");
  return choice(args, "end", ["fore", "aft"] as const, "fore");
}
