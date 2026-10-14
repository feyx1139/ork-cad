// Turns a rocket model into files: an STL per part for printing (one copy of the part, so a fin
// set's file is one fin), and on request STEP files with the exact surfaces for Onshape (every copy
// in its place on the rocket, plus the whole rocket in one file). Works the same in Node and in a
// browser.

import { exportSTEP, type Shape3D } from "replicad";
import { allParts, UnsupportedError, type Part, type RocketModel } from "../ork/model.ts";
import { buildPart } from "../geometry/parts.ts";
import { solidVolume } from "../geometry/measure.ts";
import { stlMesh, writeSTL } from "../geometry/stl.ts";

/** STL triangles stay within 0.01 mm of the exact surface and turn at most 0.05 rad (3°) each. */
export const PRINT_MESH = { tolerance: 0.01, angularTolerance: 0.05 };

/** A solid as a binary STL file: a closed surface, corners exactly on the solid's surface. */
export function stlOf(shape: Shape3D, title: string): Uint8Array {
  const m = shape.mesh(PRINT_MESH);
  return writeSTL(stlMesh(m.vertices, m.triangles), title);
}

export interface ExportedPart {
  part: Part;
  /** File name, numbered in rocket order, e.g. "01 Nose Cone.stl" or "05 Fin set (print 3).stl". */
  fileName: string;
  /** Binary STL of one copy, in its place on the rocket. */
  stl: Uint8Array;
  /** Every copy in its place, with exact surfaces (only when asked for). */
  step?: Blob;
  copies: number;
  /** Total of all copies, mm³. */
  volume: number;
  /** Separate solids: one per copy, more if a part comes in pieces. */
  pieces: number;
  /** From the part's material in the .ork, kg/m³ (undefined if it has none). */
  density?: number;
  /** Mass typed into OpenRocket as an override for this part, grams (undefined if none). */
  massOverride?: number;
  warnings: string[];
}

export interface ExportResult {
  parts: ExportedPart[];
  /** Parts the tool can't build yet, with the reason. */
  skipped: { part: Part; reason: string }[];
  /** Every part in one STEP file, in place (only when STEP was asked for). */
  assembly?: Blob;
}

export function exportRocket(model: RocketModel, { step = false }: { step?: boolean } = {}): ExportResult {
  const parts: ExportedPart[] = [];
  const skipped: ExportResult["skipped"] = [];
  const assembly: { shape: Shape3D; name: string }[] = [];
  for (const part of allParts(model)) {
    let built;
    try {
      built = buildPart(part, model);
    } catch (e) {
      if (!(e instanceof UnsupportedError)) throw e;
      skipped.push({ part, reason: e.message });
      continue;
    }
    if (!built) continue;
    const number = String(parts.length + 1).padStart(2, "0");
    const name = safeFileName(part.name);
    const copies = built.solids.length;
    const density = Number(part.node?.fields.get("material")?.attrs.density);
    const override = Number(part.node?.fields.get("overridemass")?.text);
    const exported: ExportedPart = {
      part,
      fileName: `${number} ${stlName(name, copies)}`,
      stl: stlOf(built.solids[0], part.name),
      copies,
      volume: built.solids.reduce((sum, s) => sum + solidVolume(s), 0),
      pieces: built.solids.reduce((n, s) => n + s.solids.length, 0),
      density: Number.isFinite(density) ? density : undefined,
      massOverride: Number.isFinite(override) ? override * 1000 : undefined,
      warnings: built.warnings,
    };
    if (step) {
      exported.step = stepOf(part, built.solids);
      built.solids.forEach((shape, i) => assembly.push({ shape: shape.clone(), name: copyName(part, copies, i) }));
    }
    parts.push(exported);
  }
  return { parts, skipped, assembly: step ? exportSTEP(assembly, { unit: "mm", modelUnit: "mm" }) : undefined };
}

/** "Fin set (print 3).stl": the file holds one copy, and the name says how many to print. */
export function stlName(name: string, copies: number): string {
  return `${name}${copies > 1 ? ` (print ${copies})` : ""}.stl`;
}

/** Every copy of a part in one STEP file, in place. */
export function stepOf(part: Part, solids: Shape3D[]): Blob {
  return exportSTEP(
    solids.map((shape, i) => ({ shape, name: copyName(part, solids.length, i) })),
    { unit: "mm", modelUnit: "mm" },
  );
}

function copyName(part: Part, copies: number, i: number): string {
  return copies > 1 ? `${part.name} ${i + 1}` : part.name;
}

/** Removes characters Windows doesn't allow in file names. */
export function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim() || "part";
}
