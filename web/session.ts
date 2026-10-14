// The design the website is working on: opening it, building and meshing its parts, editing their
// details, comparing a part with a CAD file of the real thing, and making the downloads. It has no page or worker code in it, so it runs (and is
// tested) in Node as well as in the browser's worker. OpenCASCADE must already be loaded.

import type { Shape3D } from "replicad";
import { strToU8, zipSync } from "fflate";
import { readOrk, type XmlDocument } from "../src/ork/read.ts";
import { allParts, buildModel, type Part, type RocketModel, type TransitionPart } from "../src/ork/model.ts";
import { setComment, type XmlTools } from "../src/ork/write.ts";
import { FeatureError, parseFeatures } from "../src/features/parse.ts";
import { buildPart } from "../src/geometry/parts.ts";
import { solidVolume } from "../src/geometry/measure.ts";
import { findCompartments } from "../src/checks/compartments.ts";
import { safeFileName, stepOf, stlName, stlOf } from "../src/export/files.ts";
import { reportText } from "../src/export/report.ts";
import { readCad } from "../src/match/cad.ts";
import { applyMatch, matchPart, matchText, type MatchResult } from "../src/match/compare.ts";

/** A comparison of a part with a CAD file, for the page. */
export interface MatchView extends MatchResult {
  key: string;
  /** The whole result in words. */
  text: string;
}

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

/** Fine enough to look smooth on screen; STL files for printing use the finer PRINT_MESH (src/export/files.ts). */
const VIEW_MESH = { tolerance: 0.05, angularTolerance: 0.2 };
const PRINTED = /PLA|PETG|ABS|ASA|nylon|resin|print/i;

export class Session {
  private solids = new Map<string, Shape3D[]>();
  private views = new Map<string, PartView>();
  private edited = new Set<string>();
  private keys = new Map<Part, string>();
  private matches = new Map<string, MatchResult>();
  /** Changes made from a comparison, which are in `bytes` but not saved yet. */
  private changed = false;
  rocket: RocketView;
  model: RocketModel;
  private bytes: Uint8Array;
  private xml: XmlTools;

  private constructor(rocket: RocketView, bytes: Uint8Array, model: RocketModel, xml: XmlTools) {
    this.rocket = rocket;
    this.bytes = bytes;
    this.model = model;
    this.xml = xml;
    this.keyParts();
  }

  static open(bytes: Uint8Array, fileName: string, xml: XmlTools): Session {
    const model = Session.read(bytes, xml);
    return new Session({ name: model.name, fileName, length: model.length, creator: model.creator }, bytes, model, xml);
  }

  private static read(bytes: Uint8Array, xml: XmlTools): RocketModel {
    return buildModel(
      readOrk(bytes, (text) => xml.parse(text) as unknown as XmlDocument),
      { keepDetailErrors: true },
    );
  }

  private keyParts(): void {
    // The OpenRocket id where there is one (all files from OpenRocket 22+), otherwise the position.
    this.keys = new Map();
    allParts(this.model).forEach((p, i) => this.keys.set(p, p.id || `part-${i}`));
  }

  /** Parts with a shape, in rocket order (mass components and recovery gear have none). */
  get parts(): Part[] {
    return allParts(this.model).filter((p) => p.kind !== "other");
  }

  get hasEdits(): boolean {
    return this.edited.size > 0 || this.changed;
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

  /** One part as STL (one copy, for printing) or STEP (every copy in place, exact, for Onshape). */
  async partFile(key: string, format: "stl" | "step"): Promise<FileOut> {
    const part = this.part(key);
    const solids = this.solids.get(key) ?? [];
    if (!solids.length) throw new Error(`${part.name} has no shape to export.`);
    const base = safeFileName(part.name);
    if (format === "step") return { name: `${base}.step`, bytes: await bytesOf(stepOf(part, solids)) };
    return { name: stlName(base, solids.length), bytes: stlOf(solids[0], part.name) };
  }

  /** Every part as an STL for printing, and report.txt. */
  async zip(): Promise<FileOut> {
    const files: Record<string, Uint8Array> = {};
    const reportParts = [];
    let n = 0;
    for (const part of this.parts) {
      const key = this.keyOf(part);
      const view = this.views.get(key);
      if (!this.solids.get(key)?.length || !view) continue;
      const stl = await this.partFile(key, "stl");
      const fileName = `${String(++n).padStart(2, "0")} ${stl.name}`;
      files[fileName] = stl.bytes;
      reportParts.push({ ...view, fileName, details: view.details ? view.details.split("\n") : [] });
    }
    files["report.txt"] = strToU8(reportText(this.model, reportParts, findCompartments(this.model)));
    const name = safeFileName(this.rocket.fileName.replace(/\.ork$/i, "")) || "rocket";
    return { name: `${name} parts.zip`, bytes: zipSync(files) };
  }

  /**
   * Compares a nose cone or transition with a CAD file of the real part (STEP or STL), and works
   * out what to change in the design so it makes that part. Nothing changes until applyMatch.
   */
  async compare(key: string, bytes: Uint8Array, fileName: string, options: { flip?: boolean; progress?: (text: string) => void } = {}): Promise<MatchView> {
    const part = this.part(key);
    if (part.kind !== "transition") throw new Error(`Only nose cones and transitions can be compared with a CAD file so far.`);
    options.progress?.(`Reading ${fileName}…`);
    const cad = await readCad(bytes, fileName);
    const result = matchPart(this.model, part, cad, fileName, options);
    this.matches.set(key, result);
    return { ...result, key, text: matchText(result) };
  }

  /**
   * Makes the changes from the last comparison of a part: its fields and detail lines change in
   * the design, which is then read again (every part is rebuilt by buildAll).
   */
  applyMatch(key: string): void {
    const result = this.matches.get(key);
    if (!result) throw new Error("Compare the part with a CAD file first.");
    const part = this.part(key) as TransitionPart;
    // Detail lines edited on this page go in first, so none are lost.
    const bytes = applyMatch(this.saveOrk().bytes, part, result, this.xml);
    for (const list of this.solids.values()) for (const solid of list) solid.delete();
    this.solids.clear();
    this.views.clear();
    this.edited.clear();
    this.matches.clear();
    this.bytes = bytes;
    this.model = Session.read(bytes, this.xml);
    this.rocket = { ...this.rocket, name: this.model.name, length: this.model.length };
    this.keyParts();
    this.changed = true;
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
