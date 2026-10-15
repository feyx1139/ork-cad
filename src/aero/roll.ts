// How fast canted fins spin a rocket, worked out the way OpenRocket 24.12 does it (its
// FinSetCalc, Barrowman's method), so the numbers agree with OpenRocket's simulations.
//
// Each canted fin pushes the rocket round (roll forcing); as it spins, each fin meets the air at a
// smaller angle, which pushes back (roll damping, growing with the spin). The spin settles where
// the two cancel. Both are per fin, so the number of fins doesn't matter, and below the speed of
// sound the steady spin grows in step with the speed: twice as fast, twice the spin.

import type { FinSetPart } from "../ork/model.ts";

/** OpenRocket splits the fin's span into this many stations (FinSetCalc.DIVISIONS). */
const DIVISIONS = 48;
/** Above this angle a fin section is stalled; OpenRocket caps each station's angle there for damping. */
const STALL = (15 * Math.PI) / 180;
/** Speed of sound for the Mach number when none is given (15 °C), m/s. */
export const SOUND = 340.3;
/** Where the side of an egg is, from the rocket's axis, for the push of the spin on it (mm). */
export const EGG_RADIUS = 22;
const G = 9.80665;

/** The fin's planform as OpenRocket uses it, metres: span stations, chord at each, and area. */
interface Planform {
  span: number;
  area: number;
  /** Mean aerodynamic chord's distance out from the root. */
  macSpan: number;
  /** Average cosine of the mid-chord line's sweep. */
  cosGamma: number;
  /** Σ c (r + y)² dy over the stations: what the damping depends on. */
  rollSum: number;
  /** Chord length at each station. */
  chords: number[];
  /** Body radius at the root. */
  r: number;
}

function planform(p: FinSetPart): Planform {
  const o = p.outline;
  const mm = 1e-3;
  let span: number;
  let area: number;
  /** Leading and trailing edge, and how much of the chord is fin, at height y above the root (mm). */
  let at: (y: number) => { lead: number; trail: number; length: number };
  if (o.shape === "elliptical") {
    const c = o.rootChord / 2;
    span = o.height;
    area = (Math.PI / 4) * o.rootChord * o.height;
    at = (y) => {
      const half = c * Math.sqrt(Math.max(0, 1 - (y / o.height) ** 2));
      return { lead: c - half, trail: c + half, length: 2 * half };
    };
  } else {
    const pts: [number, number][] =
      o.shape === "trapezoid"
        ? [
            [0, 0],
            [o.sweep, o.height],
            [o.sweep + o.tipChord, o.height],
            [o.rootChord, 0],
          ]
        : o.points;
    span = Math.max(...pts.map(([, y]) => y));
    area = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      area += x1 * y2 - x2 * y1;
    }
    area = Math.abs(area) / 2;
    at = (y) => {
      // Where the outline crosses this height: the fin is between pairs of crossings.
      const xs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[(i + 1) % pts.length];
        if (y1 === y2) continue;
        const lo = Math.min(y1, y2);
        const hi = Math.max(y1, y2);
        // Count the top end of each edge, not the bottom, so a corner isn't counted twice; the
        // tip itself is reached from below.
        if (y < lo || y > hi || (y === lo && lo !== span)) continue;
        xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
      xs.sort((a, b) => a - b);
      let length = 0;
      for (let k = 0; k + 1 < xs.length; k += 2) length += xs[k + 1] - xs[k];
      return xs.length ? { lead: xs[0], trail: xs[xs.length - 1], length } : { lead: 0, trail: 0, length: 0 };
    };
  }
  const r = p.bodyRadius * mm;
  const s = span * mm;
  const dy = s / (DIVISIONS - 1);
  const chords: number[] = [];
  let macSpan = 0;
  let sum = 0;
  let rollSum = 0;
  let cosGamma = 0;
  let prevMid = 0;
  for (let i = 0; i < DIVISIONS; i++) {
    const y = i * dy;
    const { lead, trail, length } = at(Math.min(span, (y / mm)));
    const chord = Math.min(length, trail - lead) * mm;
    chords.push(chord);
    macSpan += y * (trail - lead) * mm;
    sum += (trail - lead) * mm;
    rollSum += chord * (r + y) ** 2;
    const mid = ((lead + trail) / 2) * mm;
    if (i > 0) cosGamma += dy / Math.hypot(mid - prevMid, dy);
    prevMid = mid;
  }
  return {
    span: s,
    area: area * mm * mm,
    macSpan: sum > 0 ? macSpan / sum : 0,
    cosGamma: cosGamma / (DIVISIONS - 1),
    rollSum: rollSum * dy,
    chords,
    r,
  };
}

/**
 * The spin canted fins settle at, rad/s (positive in the sense the cant turns the rocket), at this
 * speed (m/s) and Mach number. Below Mach 0.9, as OpenRocket's subsonic formulas.
 */
export function steadyRoll(p: FinSetPart, speed: number, mach = speed / SOUND): number {
  if (p.cant === 0 || speed <= 0) return 0;
  if (mach > 0.9) throw new Error("The spin estimate is for subsonic flight (below Mach 0.9).");
  const f = planform(p);
  const s = f.span;
  const beta = Math.sqrt(1 - mach * mach);
  // One fin's normal force slope, times the reference area (which cancels out).
  const cna1 = (2 * Math.PI * s * s) / (1 + Math.sqrt(1 + (1 - mach * mach) * ((s * s) / (f.area * f.cosGamma)) ** 2));
  const tau = f.r / (s + f.r);
  const forcing = (f.macSpan + f.r) * cna1 * (1 + tau) * Math.abs(p.cant);
  const damping = (rate: number) => {
    if ((rate * (f.r + s)) / speed > STALL) {
      // The fin tips are stalled: each station's angle is capped (FinSetCalc.calculateDampingMoment).
      let sum = 0;
      for (let i = 0; i < DIVISIONS; i++) {
        const dist = f.r + (s * i) / DIVISIONS;
        sum += f.chords[i] * dist * Math.min((rate * dist) / speed, STALL);
      }
      return (sum * (s / DIVISIONS) * 2 * Math.PI) / beta;
    }
    return (2 * Math.PI * rate * f.rollSum) / (speed * beta);
  };
  // Damping grows with the spin; find where it equals the forcing.
  let lo = 0;
  let hi = 1;
  while (damping(hi) < forcing) hi *= 2;
  for (let k = 0; k < 100; k++) {
    const mid = (lo + hi) / 2;
    if (damping(mid) < forcing) lo = mid;
    else hi = mid;
  }
  return Math.sign(p.cant) * (lo + hi) / 2;
}

/** Revolutions per second, from rad/s. */
export function revsPerSecond(rate: number): number {
  return Math.abs(rate) / (2 * Math.PI);
}

/** The push of a spin on something this far from the axis (mm), in g (9.81 m/s² each). */
export function spinLoad(rate: number, radius = EGG_RADIUS): number {
  return (rate * rate * radius * 1e-3) / G;
}
