// Turns a rocket model into files: an STL per part for printing (one copy of the part, so a fin
// set's file is one fin), and STEP files with the exact surfaces for Onshape: the whole rocket in
// one file, and one file per part. Works the same in Node and in a browser.

import { getOC, type Shape3D } from "replicad";
import { allParts, UnsupportedError, type Part, type RocketModel } from "../ork/model.ts";
import { buildPart } from "../geometry/parts.ts";
import { solidVolume } from "../geometry/measure.ts";
import { stlMesh, writeSTL } from "../geometry/stl.ts";
import { partColor } from "./colors.ts";

/** STL triangles stay within 0.01 mm of the exact surface and turn at most 0.05 rad (3°) each. */
export const PRINT_MESH = { tolerance: 0.01, angularTolerance: 0.05 };

/** A solid as a binary STL file: a closed surface, corners exactly on the solid's surface. */
export function stlOf(shape: Shape3D, title: string): Uint8Array {
  const m = shape.mesh(PRINT_MESH);
  return writeSTL(stlMesh(m.vertices, m.triangles), title);
}

/** One solid in a STEP file, with the name and colour CAD programs show for it. */
export interface StepPiece {
  name: string;
  shape: Shape3D;
  color: string;
}

/**
 * A STEP file with exact surfaces, made as an assembly: one component for each piece, named,
 * coloured and in its place on the rocket, so a CAD program (Onshape) lists every part
 * separately, with the sizes of the real curves. Millimetres.
 */
export function stepFile(name: string, pieces: StepPiece[]): Uint8Array {
  const oc = getOC();
  const text = (s: string) => new oc.TCollection_ExtendedString(s, true);
  const doc = new oc.TDocStd_Document(text("XmlOcaf"));
  oc.XCAFDoc_ShapeTool.SetAutoNaming(false);
  const main = doc.Main();
  const shapes = oc.XCAFDoc_DocumentTool.ShapeTool(main);
  const colors = oc.XCAFDoc_DocumentTool.ColorTool(main);
  const root = shapes.NewShape();
  oc.TDataStd_Name.Set(root, text(name));
  for (const p of pieces) {
    const label = shapes.AddShape(p.shape.wrapped, false, false);
    oc.TDataStd_Name.Set(label, text(p.name));
    // OpenCASCADE takes linear RGB and writes it to the file as sRGB, like the colour on screen.
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(p.color.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    colors.SetColor(label, new oc.Quantity_ColorRGBA(r, g, b, 1), oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf);
    // Already in its place, so the component isn't moved.
    const component = shapes.AddComponent(root, label, new oc.TopLoc_Location());
    oc.TDataStd_Name.Set(component, text(p.name));
  }
  shapes.UpdateAssemblies();
  // A writer first, so the STEP settings exist before they're set.
  new oc.STEPCAFControl_Writer().delete();
  oc.Interface_Static.SetCVal("xstep.cascade.unit", "MM");
  oc.Interface_Static.SetCVal("write.step.unit", "MM");
  oc.Interface_Static.SetIVal("write.surfacecurve.mode", 1);
  oc.Interface_Static.SetIVal("write.precision.mode", 0);
  oc.Interface_Static.SetIVal("write.step.assembly", 1);
  oc.Interface_Static.SetIVal("write.step.schema", 5);
  const session = new oc.XSControl_WorkSession();
  const writer = new oc.STEPCAFControl_Writer(session, false);
  writer.SetColorMode(true);
  writer.SetNameMode(true);
  const progress = new oc.Message_ProgressRange();
  try {
    if (!writer.Perform(doc, "/ork-cad.step", progress)) throw new Error("Writing the STEP file failed.");
    const bytes = new Uint8Array(oc.FS.readFile("/ork-cad.step"));
    oc.FS.unlink("/ork-cad.step");
    return bytes;
  } finally {
    for (const o of [progress, writer, session, doc]) o.delete();
  }
}

/** A part's copies as STEP pieces: "Fin set 1", "Fin set 2"... for parts with several. */
export function stepPieces(part: Part, solids: Shape3D[]): StepPiece[] {
  const material = part.node?.fields.get("material")?.text ?? "";
  return solids.map((shape, i) => ({ name: solids.length > 1 ? `${part.name} ${i + 1}` : part.name, shape, color: partColor(material) }));
}

/** Every copy of a part in one STEP file, in place. */
export function stepOf(part: Part, solids: Shape3D[]): Uint8Array {
  return stepFile(part.name, stepPieces(part, solids));
}

export interface ExportedPart {
  part: Part;
  /** File name, numbered in rocket order, e.g. "01 Nose Cone.stl" or "05 Fin set (print 3).stl". */
  fileName: string;
  /** Binary STL of one copy, in its place on the rocket. */
  stl: Uint8Array;
  /** Every copy in its place, with exact surfaces (only when asked for). */
  step?: Uint8Array;
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
  /** The whole rocket in one STEP file, every part separate and in place (only when asked for). */
  assembly?: Uint8Array;
}

export function exportRocket(model: RocketModel, { step = false }: { step?: boolean } = {}): ExportResult {
  const parts: ExportedPart[] = [];
  const skipped: ExportResult["skipped"] = [];
  const everything: StepPiece[] = [];
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
    const copies = built.solids.length;
    const density = Number(part.node?.fields.get("material")?.attrs.density);
    const override = Number(part.node?.fields.get("overridemass")?.text);
    const exported: ExportedPart = {
      part,
      fileName: `${number} ${stlName(safeFileName(part.name), copies)}`,
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
      everything.push(...stepPieces(part, built.solids));
    }
    parts.push(exported);
  }
  return { parts, skipped, assembly: step ? stepFile(model.name, everything) : undefined };
}

/** "Fin set (print 3).stl": the file holds one copy, and the name says how many to print. */
export function stlName(name: string, copies: number): string {
  return `${name}${copies > 1 ? ` (print ${copies})` : ""}.stl`;
}

/** Removes characters Windows doesn't allow in file names. */
export function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim() || "part";
}
