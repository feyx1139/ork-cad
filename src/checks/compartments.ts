// Splits the inside of the rocket into the sealed spaces between caps, bulkheads and centering
// rings, and works out what is in each one and which holes open into it. That catches vents in
// the wrong place: an altimeter space with no vent holes, or holes that let ejection gas through
// to the eggs.

import { allParts, type Part, type RocketModel } from "../ork/model.ts";
import { transitionRadius } from "../geometry/shapes.ts";
import { endFace, hasShoulder, isSolid, sideHolePosition } from "../features/part-shape.ts";

export interface Compartment {
  /** Span along the rocket axis, mm from the nose tip. */
  from: number;
  to: number;
  /** What closes it off at each end; undefined means the nose tip or the open tail. */
  foreWall?: string;
  aftWall?: string;
  /** Mass components, parachutes, shock cords and streamers whose middle is in here. */
  contents: Part[];
  altimeter: boolean;
  eggs: boolean;
  /** The motor's ejection charge fires into this space. */
  ejection: boolean;
  /** Side holes that open into it, e.g. "Transition: 3 x 2 mm". */
  vents: string[];
  /** Air volume (mm³, not counting what is inside) and the widest inside diameter (mm). */
  volume: number;
  diameter: number;
}

export interface CompartmentReport {
  compartments: Compartment[];
  warnings: string[];
  notes: string[];
}

interface Wall {
  from: number;
  to: number;
  name: string;
}

export function findCompartments(model: RocketModel): CompartmentReport {
  const parts = allParts(model);
  const walls = mergeWalls(findWalls(parts));

  const compartments: Compartment[] = [];
  let start = 0;
  let foreWall: string | undefined;
  for (const w of [...walls, { from: model.bodyLength, to: model.bodyLength, name: "" }]) {
    if (w.from - start > 1e-6) {
      compartments.push({
        from: start,
        to: w.from,
        foreWall,
        aftWall: w.name || undefined,
        contents: [],
        altimeter: false,
        eggs: false,
        ejection: false,
        vents: [],
        volume: 0,
        diameter: 0,
      });
    }
    start = Math.max(start, w.to);
    foreWall = w.name;
  }
  const at = (x: number) =>
    compartments.find((c) => c.from - 1e-6 <= x && x <= c.to + 1e-6) ??
    compartments.reduce((best, c) => (gap(c, x) < gap(best, x) ? c : best));

  for (const p of parts) {
    if (p.kind === "other" && ["masscomponent", "parachute", "streamer", "shockcord"].includes(p.type)) {
      for (const inst of p.instances) {
        const c = at(inst.x + p.length / 2);
        c.contents.push(p);
        if (isAltimeter(p)) c.altimeter = true;
        if (isEggs(p)) c.eggs = true;
      }
    }
    if (p.kind === "cylinder" && p.type === "innertube" && p.node?.complex.has("motormount")) {
      // The ejection charge fires out of the motor's front, at the fore end of the motor tube.
      at(p.instances[0].x - 0.01).ejection = true;
    }
  }

  const warnings: string[] = [];
  const notes: string[] = [];
  for (const p of parts) {
    for (const f of p.features) {
      if (f.kind === "side-holes") {
        for (const inst of p.instances) {
          const x = inst.x + sideHolePosition(p, f);
          const wall = walls.find((w) => w.from < x && x < w.to);
          if (wall) {
            notes.push(`${p.name}: "${f.source}" goes into the solid ${wall.name}, not into an open space.`);
            continue;
          }
          at(x).vents.push(`${p.name}: ${f.count} x ${round(f.diameter)} mm`);
        }
      } else {
        // End holes join the spaces on either side of the cap, bulkhead or ring they go through.
        const label = p.kind === "transition" ? `${p.name} (${endOf(p, f.end)} cap)` : p.name;
        for (const inst of p.instances) {
          const wall = walls.find(
            (w) => w.name.includes(label) && (p.kind === "transition" || (w.from - 1e-6 <= inst.x && inst.x <= w.to + 1e-6)),
          );
          const before = wall && compartments.find((c) => Math.abs(c.to - wall.from) < 1e-6);
          const after = wall && compartments.find((c) => Math.abs(c.from - wall.to) < 1e-6);
          if (!before || !after) continue;
          const gas = before.ejection ? before : after.ejection ? after : undefined;
          const other = gas === before ? after : before;
          if (gas && (other.altimeter || other.eggs)) {
            warnings.push(
              `End holes in ${p.name} let ejection gas from the motor into the space with the ` +
                `${[other.altimeter && "altimeter", other.eggs && "eggs"].filter(Boolean).join(" and ")}.`,
            );
          }
        }
      }
    }
  }

  for (const c of compartments) {
    const { volume, diameter } = airSpace(model, parts, c.from, c.to);
    c.volume = volume;
    c.diameter = diameter;
    const where = describe(c);
    if (c.altimeter && c.vents.length === 0) {
      warnings.push(
        `The altimeter is in the space ${where}, which has no vent holes. An altimeter works out altitude ` +
          `from the outside air pressure, so this space needs small vent holes to the outside.`,
      );
    }
    if (c.altimeter && c.ejection) {
      warnings.push(`The motor's ejection charge fires into the same space as the altimeter (${where}).`);
    }
    if (c.vents.length && c.ejection && !c.altimeter) {
      notes.push(
        `${c.vents.join(", ")} open into the space ${where}, which the motor's ejection charge fires into. ` +
          `Small breather holes there are common, but they let some ejection pressure out.`,
      );
    }
  }
  return { compartments, warnings, notes };
}

function findWalls(parts: Part[]): Wall[] {
  const walls: Wall[] = [];
  const pockets = findPockets(parts);
  /** A solid part blocks the inside, except where a pocket opens into it from an end. */
  const solidWall = (p: Part, from: number, to: number) => {
    for (const k of pockets.filter((k) => k.part === p)) {
      if (k.end === "fore") from = Math.max(from, k.to);
      else to = Math.min(to, k.from);
    }
    if (to - from > 1e-6) walls.push({ from, to, name: p.name });
  };
  for (const p of parts) {
    if (p.kind === "transition") {
      const x = p.instances[0].x;
      const fore = hasShoulder(p, "fore") ? p.foreShoulder : undefined;
      const aft = hasShoulder(p, "aft") ? p.aftShoulder : undefined;
      if (p.filled) {
        solidWall(p, x - (fore?.length ?? 0), x + p.length + (aft?.length ?? 0));
        continue;
      }
      if (fore?.capped) walls.push({ from: x - fore.length, to: x - fore.length + fore.thickness, name: `${p.name} (fore cap)` });
      if (aft?.capped) {
        walls.push({ from: x + p.length + aft.length - aft.thickness, to: x + p.length + aft.length, name: `${p.name} (aft cap)` });
      }
    } else if (p.kind === "cylinder" && p.type === "bulkhead") {
      for (const inst of p.instances) solidWall(p, inst.x, inst.x + p.length);
    } else if (p.kind === "cylinder" && p.type === "centeringring") {
      // A centering ring seals the space around the motor tube; the motor closes the tube itself.
      for (const inst of p.instances) walls.push({ from: inst.x, to: inst.x + p.length, name: p.name });
    }
  }
  return walls;
}

interface PocketSpan {
  part: Part;
  end: "fore" | "aft";
  /** Axial span, mm from the nose tip, and cross-section area, mm². */
  from: number;
  to: number;
  area: number;
}

/** Pockets cut into solid parts; each is open to the space at its end of the part. */
function findPockets(parts: Part[]): PocketSpan[] {
  const out: PocketSpan[] = [];
  for (const p of parts) {
    if (!isSolid(p)) continue;
    for (const f of p.features) {
      if (f.kind !== "pocket") continue;
      const face = endFace(p, f.end);
      const area =
        f.shape.kind === "round"
          ? Math.PI * (f.shape.diameter / 2) ** 2
          : f.shape.width * f.shape.height - (4 - Math.PI) * f.shape.corner ** 2;
      for (const inst of p.instances) {
        const a = inst.x + face.s;
        const b = a + face.inward * f.depth;
        out.push({ part: p, end: f.end, from: Math.min(a, b), to: Math.max(a, b), area });
      }
    }
  }
  return out;
}

function mergeWalls(walls: Wall[]): Wall[] {
  const sorted = [...walls].sort((a, b) => a.from - b.from);
  const out: Wall[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.from <= last.to + 1e-6) {
      last.to = Math.max(last.to, w.to);
      last.name = `${last.name} + ${w.name}`;
    } else {
      out.push({ ...w });
    }
  }
  return out;
}

/** Air volume and widest inside diameter between two axial positions. */
function airSpace(model: RocketModel, parts: Part[], from: number, to: number): { volume: number; diameter: number } {
  const bodies = model.stages.flatMap((s) => s.children);
  const innerTubes = parts.filter((p) => p.kind === "cylinder" && p.type === "innertube");
  const couplers = parts.filter((p) => p.kind === "cylinder" && p.type === "tubecoupler");
  const pockets = findPockets(parts);

  /** The air's cross-section at x (mm²) and the inside radius there. */
  const section = (x: number): { area: number; r: number } | undefined => {
    let r = Infinity;
    for (const b of bodies) {
      const x0 = b.instances[0].x;
      if (b.kind === "cylinder" && x0 <= x && x <= x0 + b.length) r = Math.min(r, b.innerRadius);
      if (b.kind === "transition") {
        const s = x - x0;
        if (0 <= s && s <= b.length) {
          const h = 1e-3;
          const slope = (transitionRadius(b, s + h) - transitionRadius(b, s - h)) / (2 * h);
          const inner = b.filled ? 0 : transitionRadius(b, s) - b.thickness * Math.hypot(1, slope);
          r = Math.min(r, Math.max(0, inner));
        }
        for (const side of ["fore", "aft"] as const) {
          if (!hasShoulder(b, side)) continue;
          const sh = side === "fore" ? b.foreShoulder : b.aftShoulder;
          const s0 = side === "fore" ? -sh.length : b.length;
          if (s0 <= s && s <= s0 + sh.length) r = Math.min(r, b.filled ? 0 : sh.radius - sh.thickness);
        }
      }
    }
    for (const c of couplers) {
      for (const inst of c.instances) {
        if (c.kind === "cylinder" && inst.x <= x && x <= inst.x + c.length) r = Math.min(r, c.innerRadius);
      }
    }
    if (!Number.isFinite(r)) return undefined;
    // Inside a solid part, the only air is in its pockets.
    const pocketArea = pockets.filter((k) => k.from <= x && x <= k.to).reduce((sum, k) => sum + k.area, 0);
    let area = r === 0 ? pocketArea : Math.PI * r * r;
    for (const t of innerTubes) {
      for (const inst of t.instances) {
        if (t.kind === "cylinder" && inst.x <= x && x <= inst.x + t.length) area -= Math.PI * t.outerRadius ** 2;
      }
    }
    return { area: Math.max(0, area), r };
  };

  // The inside only changes where a part starts or ends, and gradually within a nose cone or
  // transition, so add it up piece by piece with 3-point Gauss quadrature: exact for tubes and cones.
  const cuts = [from, to];
  const cut = (x: number) => {
    if (x > from && x < to) cuts.push(x);
  };
  for (const b of bodies) {
    const x0 = b.instances[0].x;
    cut(x0);
    cut(x0 + b.length);
    if (b.kind === "transition") {
      if (hasShoulder(b, "fore")) cut(x0 - b.foreShoulder.length);
      if (hasShoulder(b, "aft")) cut(x0 + b.length + b.aftShoulder.length);
    }
  }
  for (const p of [...couplers, ...innerTubes]) {
    for (const inst of p.instances) {
      cut(inst.x);
      cut(inst.x + p.length);
    }
  }
  for (const k of pockets) {
    cut(k.from);
    cut(k.to);
  }
  cuts.sort((a, b) => a - b);
  const curved = (x: number) =>
    bodies.some((b) => b.kind === "transition" && b.foreRadius !== b.aftRadius && b.instances[0].x < x && x < b.instances[0].x + b.length);
  const gauss: [number, number][] = [
    [-Math.sqrt(3 / 5), 5 / 9],
    [0, 8 / 9],
    [Math.sqrt(3 / 5), 5 / 9],
  ];
  let volume = 0;
  let rMax = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    const n = curved((a + b) / 2) ? Math.ceil((b - a) / 0.5) : 1;
    const h = (b - a) / n;
    for (let j = 0; j < n; j++) {
      const m = a + (j + 0.5) * h;
      for (const [g, w] of gauss) {
        const s = section(m + (g * h) / 2);
        if (!s) continue;
        volume += (w * h * s.area) / 2;
        rMax = Math.max(rMax, s.r);
      }
    }
  }
  return { volume, diameter: 2 * rMax };
}

function isAltimeter(p: Part): boolean {
  const type = p.node?.fields.get("masscomponenttype")?.text;
  return type === "altimeter" || type === "flightcomputer" || /altimeter|flight\s*computer/i.test(p.name);
}

function isEggs(p: Part): boolean {
  return /\begg/i.test(p.name);
}

function endOf(p: Part, end: "fore" | "aft" | undefined): "fore" | "aft" {
  if (end) return end;
  return p.kind === "transition" && hasShoulder(p, "fore") && p.foreShoulder.capped ? "fore" : "aft";
}

function gap(c: Compartment, x: number): number {
  return x < c.from ? c.from - x : x > c.to ? x - c.to : 0;
}

function describe(c: Compartment): string {
  const ends = `${c.foreWall ? `after ${c.foreWall}` : "from the nose tip"}, ${c.aftWall ? `up to ${c.aftWall}` : "to the tail"}`;
  return `${round(c.from)}–${round(c.to)} mm from the nose tip (${ends})`;
}

export function round(v: number): string {
  return String(Number(v.toFixed(1)));
}
