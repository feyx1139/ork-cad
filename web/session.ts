// The design the website is working on: opening it, building and meshing its parts, editing their
// details, and making the downloads. It has no page or worker code in it, so it runs (and is
// tested) in Node as well as in the browser's worker. OpenCASCADE must already be loaded.

import { exportSTEP, type Shape3D } from "replicad";
import { strToU8, zipSync } from "fflate";
import { readOrk, type XmlDocument } from "../src/ork/read.ts";
import { allParts, buildModel, type Part, type RocketModel } from "../src/ork/model.ts";
import { setComment, type XmlTools } from "../src/ork/write.ts";
import { FeatureError, parseFeatures } from "../src/features/parse.ts";
import { buildPart } from "../src/geometry/parts.ts";
import { solidVolume } from "../src/geometry/measure.ts";
import { findCompartments } from "../src/checks/compartments.ts";
import { safeFileName } from "../src/export/step.ts";
import { reportText } from "../src/export/report.ts";

/** Triangles for a part's surfaces and line segments for its edges, in the rocket's frame (mm). */
export interface PartMesh {
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
  edges: Float32Array;
}

export interface PartView {
  key: string;
  name: string;
  type: string;
  /** The detail lines (@...) of its comment. The rest of the comment is kept as it is. */
  details: string;
  material: string;
  density?: number;
  massOverride?: number;
  copies: number;
  /** mm³, all copies. */
  volume: number;
  /** The material looks 3D printed (PLA, PETG...). */
  printed: boolean;
  warnings: string[];
  /** Detail lines that can't be read or don't fit; the part is shown without them. */
  errors: string[];
  mesh?: PartMesh;
}

export interface SpacesView {
  spaces: {
    from: number;
    to: number;
    contents: string[];
    ejection: boolean;
    altimeter: boolean;
    vents: string[];
    volume: number;
    diameter: number;
    openAtTail: boolean;
  }[];
  warnings: string[];
  notes: string[];
}

export interface RocketView {
  name: string;
  fileName: string;
  length: number;
  creator: string;
}

export interface FileOut {
  name: string;
  bytes: Uint8Array;
}

/** Fine enough to look smooth on screen; STL files for printing use the finer one. */
const VIEW_MESH = { tolerance: 0.05, angularTolerance: 0.2 };
const PRINT_MESH = { tolerance: 0.01, angularTolerance: 0.05 };
const PRINTED = /PLA|PETG|ABS|ASA|nylon|resin|print/i;

export class Session {
  private solids = new Map<string, Shape3D[]>();
  private views = new Map<string, PartView>();
  private edited = new Set<string>();
  private keys = new Map<Part, string>();
  readonly rocket: RocketView;
  readonly model: RocketModel;
  private bytes: Uint8Array;
  private xml: XmlTools;

  private constructor(rocket: RocketView, bytes: Uint8Array, model: RocketModel, xml: XmlTools) {
    this.rocket = rocket;
    this.bytes = bytes;
    this.model = model;
    this.xml = xml;
    // The OpenRocket id where there is one (all files from OpenRocket 22+), otherwise the position.
    allParts(model).forEach((p, i) => this.keys.set(p, p.id || `part-${i}`));
  }

  static open(bytes: Uint8Array, fileName: string, xml: XmlTools): Session {
    const file = readOrk(bytes, (text) => xml.parse(text) as unknown as XmlDocument);
    const model = buildModel(file, { keepDetailErrors: true });
    return new Session({ name: model.name, fileName, length: model.length, creator: model.creator }, bytes, model, xml);
  }

  /** Parts with a shape, in rocket order (mass components and recovery gear have none). */
  get parts(): Part[] {
    return allParts(this.model).filter((p) => p.kind !== "other");
  }

  get hasEdits(): boolean {
    return this.edited.size > 0;
  }

  keyOf(part: Part): string {
    return this.keys.get(part)!;
  }

  part(key: string): Part {
    const p = this.parts.find((q) => this.keyOf(q) === key);
    if (!p) throw new Error(`No part ${key}.`);
    return p;
  }

  /** Builds every part, reporting each as it's done. */
  buildAll(onPart?: (view: PartView, done: number, total: number) => void): PartView[] {
    const parts = this.parts;
    return parts.map((p, i) => {
      const view = this.build(p);
      onPart?.(view, i + 1, parts.length);
      return view;
    });
  }

  build(part: Part): PartView {
    const key = this.keyOf(part);
    const errors = [...part.detailErrors];
    let solids: Shape3D[] = [];
    let warnings: string[] = [];
    try {
      ({ solids, warnings } = buildPart(part, this.model)!);
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      errors.push(e.message);
      if (e instanceof FeatureError) {
        // Show the part without its details rather than not at all.
        const features = part.features;
        part.features = [];
        try {
          ({ solids, warnings } = buildPart(part, this.model)!);
        } finally {
          part.features = features;
        }
      }
    }
    for (const old of this.solids.get(key) ?? []) old.delete();
    this.solids.set(key, solids);

    const material = part.node?.fields.get("material");
    const density = Number(material?.attrs.density);
    const override = Number(part.node?.fields.get("overridemass")?.text);
    const view: PartView = {
      key,
      name: part.name,
      type: part.type,
      details: detailLines(part.comment).join("\n"),
      material: material?.text ?? "",
      density: Number.isFinite(density) ? density : undefined,
      massOverride: Number.isFinite(override) ? override * 1000 : undefined,
      copies: part.instances.length,
      volume: solids.reduce((sum, s) => sum + solidVolume(s), 0),
      printed: PRINTED.test(material?.text ?? ""),
      warnings,
      errors,
      mesh: solids.length ? meshOf(solids) : undefined,
    };
    this.views.set(key, view);
    return view;
  }

  /**
   * Replaces a part's detail lines and rebuilds it. Lines that don't start with "@" are kept in the
   * comment as plain notes.
   */
  setDetails(key: string, details: string): PartView {
    const part = this.part(key);
    const lines = details.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const detail = lines.filter((l) => l.startsWith("@"));
    const stray = lines.filter((l) => !l.startsWith("@"));
    const notes = part.comment.split(/\r?\n/).filter((l) => !l.trim().startsWith("@"));
    part.comment = [...notes, ...stray, ...detail].join("\n").trim();
    const { features, errors } = parseFeatures(detail.join("\n"));
    part.features = features;
    part.detailErrors = [...stray.map((l) => `"${l}" doesn't start with @, so it was kept as a plain note.`), ...errors];
    this.edited.add(key);
    return this.build(part);
  }

  spaces(): SpacesView {
    const report = findCompartments(this.model);
    return {
      spaces: report.compartments.map((c) => ({
        from: c.from,
        to: c.to,
        contents: c.contents.map((p) => p.name),
        ejection: c.ejection,
        altimeter: c.altimeter,
        vents: c.vents,
        volume: c.volume,
        diameter: c.diameter,
        openAtTail: !c.aftWall,
      })),
      warnings: report.warnings,
      notes: report.notes,
    };
  }

  /** One part as STEP (every copy, in place) or STL (one copy, for printing). */
  async partFile(key: string, format: "step" | "stl"): Promise<FileOut> {
    const part = this.part(key);
    const solids = this.solids.get(key) ?? [];
    if (!solids.length) throw new Error(`${part.name} has no shape to export.`);
    const base = safeFileName(part.name);
    if (format === "step") return { name: `${base}.step`, bytes: await bytesOf(stepOf(part, solids)) };
    const copies = solids.length > 1 ? ` (print ${solids.length})` : "";
    return { name: `${base}${copies}.stl`, bytes: await bytesOf(solids[0].blobSTL({ ...PRINT_MESH, binary: true })) };
  }

  /** Every part as STEP and STL, the whole rocket as one STEP, and report.txt. */
  async zip(): Promise<FileOut> {
    const files: Record<string, Uint8Array> = {};
    const assembly: { shape: Shape3D; name: string }[] = [];
    const reportParts = [];
    let n = 0;
    for (const part of this.parts) {
      const key = this.keyOf(part);
      const solids = this.solids.get(key) ?? [];
      const view = this.views.get(key);
      if (!solids.length || !view) continue;
      const number = String(++n).padStart(2, "0");
      const step = await this.partFile(key, "step");
      const stl = await this.partFile(key, "stl");
      files[`step/${number} ${step.name}`] = step.bytes;
      files[`stl/${number} ${stl.name}`] = stl.bytes;
      solids.forEach((s, i) => assembly.push({ shape: s.clone(), name: solids.length > 1 ? `${part.name} ${i + 1}` : part.name }));
      reportParts.push({ ...view, fileName: `${number} ${step.name}`, details: view.details ? view.details.split("\n") : [] });
    }
    files["assembly.step"] = await bytesOf(exportSTEP(assembly, { unit: "mm", modelUnit: "mm" }));
    files["report.txt"] = strToU8(reportText(this.model, reportParts, findCompartments(this.model)));
    const name = safeFileName(this.rocket.fileName.replace(/\.ork$/i, "")) || "rocket";
    return { name: `${name} parts.zip`, bytes: zipSync(files) };
  }

  /** The design with the edited detail lines written into the components' comments. */
  saveOrk(): FileOut {
    let bytes = this.bytes;
    for (const key of this.edited) {
      const part = this.part(key);
      if (!part.id) throw new Error(`${part.name} has no OpenRocket id, so its details can't be saved into this file.`);
      bytes = setComment(bytes, part.id, part.comment, this.xml);
    }
    return { name: this.rocket.fileName, bytes };
  }
}

export function detailLines(comment: string): string[] {
  return comment.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("@"));
}

function stepOf(part: Part, solids: Shape3D[]): Blob {
  return exportSTEP(
    solids.map((shape, i) => ({ shape, name: solids.length > 1 ? `${part.name} ${i + 1}` : part.name })),
    { unit: "mm", modelUnit: "mm" },
  );
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function meshOf(solids: Shape3D[]): PartMesh {
  const vertices: number[] = [];
  const normals: number[] = [];
  const triangles: number[] = [];
  const edges: number[] = [];
  for (const s of solids) {
    const m = s.mesh(VIEW_MESH);
    const offset = vertices.length / 3;
    for (const v of m.vertices) vertices.push(v);
    for (const v of m.normals) normals.push(v);
    for (const t of m.triangles) triangles.push(t + offset);
    for (const v of s.meshEdges(VIEW_MESH).lines) edges.push(v);
  }
  return {
    vertices: Float32Array.from(vertices),
    normals: Float32Array.from(normals),
    triangles: Uint32Array.from(triangles),
    edges: Float32Array.from(edges),
  };
}
