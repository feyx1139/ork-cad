// The plain-text summary that goes with exported parts: each part's volume and mass, its details
// and notes, and the rocket's sealed spaces with their warnings.

import type { RocketModel } from "../ork/model.ts";
import { round, type CompartmentReport } from "../checks/compartments.ts";

export interface ReportPart {
  fileName: string;
  /** mm³, all copies. */
  volume: number;
  density?: number;
  massOverride?: number;
  details: string[];
  warnings: string[];
  errors: string[];
}

export function reportText(model: RocketModel, parts: ReportPart[], spaces: CompartmentReport): string {
  const lines = [`${model.name}: ${model.length.toFixed(1)} mm long (${model.creator})`, ""];
  for (const p of parts) {
    const mass = p.density ? ` = ${(p.volume * 1e-6 * p.density).toFixed(1)} g at ${p.density} kg/m³` : "";
    const override = p.massOverride !== undefined ? ` (OpenRocket mass override: ${p.massOverride.toFixed(1)} g)` : "";
    lines.push(`  ${p.fileName}  ${(p.volume / 1000).toFixed(2)} cm³${mass}${override}`);
    for (const d of p.details) lines.push(`    detail: ${d}`);
    for (const e of p.errors) lines.push(`    PROBLEM: ${e}`);
    for (const w of p.warnings) lines.push(`    note: ${w}`);
  }
  lines.push("", "Sealed spaces, nose to tail:");
  spaces.compartments.forEach((c, i) => {
    const what = [...c.contents.map((p) => p.name), ...(c.ejection ? ["the motor's ejection charge"] : [])];
    const air = c.volume > 0 ? `, ${round(c.volume / 1000)} cm³ of air (${round(c.volume / 16387.064)} in³), ${round(c.diameter)} mm across` : "";
    const open = c.aftWall ? "" : " (open at the tail)";
    lines.push(`  ${i + 1}. ${round(c.from)}–${round(c.to)} mm${air}${open}`);
    lines.push(`     holds: ${what.length ? what.join(", ") : "nothing"}`);
    lines.push(`     vents: ${c.vents.length ? c.vents.join(", ") : "none"}`);
  });
  for (const w of spaces.warnings) lines.push(`WARNING: ${w}`);
  for (const n of spaces.notes) lines.push(`note: ${n}`);
  return lines.join("\n") + "\n";
}
