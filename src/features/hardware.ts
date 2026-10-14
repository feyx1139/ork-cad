// Screw and hex nut sizes for nut traps. The table holds the real nut sizes; nut pockets get extra
// room so a printed pocket still takes the nut (+0.6 mm across the flats, +0.8 mm in thickness).
// For M4 that's a 4.2 mm screw hole and a nut pocket 7.6 mm across the flats and 4.0 mm thick.

export interface NutSize {
  /** Clearance hole for the screw, mm. */
  hole: number;
  /** Nut width across the flats, mm. */
  flats: number;
  /** Nut thickness, mm. */
  thickness: number;
}

export const NUT_ROOM = { flats: 0.6, thickness: 0.8 };

const NUTS: Record<string, NutSize> = {
  M3: { hole: 3.2, flats: 5.5, thickness: 2.4 },
  M4: { hole: 4.2, flats: 7.0, thickness: 3.2 },
  M5: { hole: 5.2, flats: 8.0, thickness: 4.7 },
  M6: { hole: 6.2, flats: 10.0, thickness: 5.2 },
  "#4-40": { hole: 3.0, flats: 6.35, thickness: 2.38 },
  "#6-32": { hole: 3.7, flats: 7.94, thickness: 2.78 },
  "#8-32": { hole: 4.4, flats: 8.73, thickness: 3.18 },
  "#10-24": { hole: 5.0, flats: 9.53, thickness: 3.18 },
  "#10-32": { hole: 5.0, flats: 9.53, thickness: 3.18 },
  "1/4-20": { hole: 6.6, flats: 11.11, thickness: 5.56 },
};

/** Looks up "M4", "m4", "8-32", "#8-32", "1/4-20"... */
export function nutSize(name: string): NutSize | undefined {
  const key = name.trim().toUpperCase().replace(/^(\d+-\d+)$/, "#$1");
  return NUTS[key] ?? NUTS[key.replace(/^#/, "")];
}

export const NUT_NAMES = Object.keys(NUTS);
