// Turns a rocket model into STEP files: one per part (all copies of that part in one file, e.g.
// every fin) plus one with the whole rocket. Works the same in Node and in a browser.

import { exportSTEP, type Shape3D } from "replicad";
import { allParts, UnsupportedError, type Part, type RocketModel } from "../ork/model.ts";
import { buildPart } from "../geometry/parts.ts";
import { solidVolume } from "../geometry/measure.ts";

export interface ExportedPart {
  part: Part;
  /** File name, numbered in rocket order, e.g. "01 Nose Cone.step". */
  fileName: string;
  step: Blob;
  /** Total of all copies, mm³. */
  volume: number;
  /** Separate solids in the file: one per copy, more if a part comes in pieces. */
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
  /** Every part in one STEP file, in place. */
  assembly: Blob;
}

export function exportRocket(model: RocketModel): ExportResult {
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
    const names = built.solids.map((_, i) => (built.solids.length > 1 ? `${part.name} ${i + 1}` : part.name));
    const step = exportSTEP(
      built.solids.map((shape, i) => ({ shape, name: names[i] })),
      { unit: "mm", modelUnit: "mm" },
    );
    built.solids.forEach((shape, i) => assembly.push({ shape: shape.clone(), name: names[i] }));
    const density = Number(part.node?.fields.get("material")?.attrs.density);
    const override = Number(part.node?.fields.get("overridemass")?.text);
    parts.push({
      part,
      fileName: `${String(parts.length + 1).padStart(2, "0")} ${safeFileName(part.name)}.step`,
      step,
      volume: built.solids.reduce((sum, s) => sum + solidVolume(s), 0),
      pieces: built.solids.reduce((n, s) => n + s.solids.length, 0),
      density: Number.isFinite(density) ? density : undefined,
      massOverride: Number.isFinite(override) ? override * 1000 : undefined,
      warnings: built.warnings,
    });
  }
  return { parts, skipped, assembly: exportSTEP(assembly, { unit: "mm", modelUnit: "mm" }) };
}

/** Removes characters Windows doesn't allow in file names. */
export function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim() || "part";
}
