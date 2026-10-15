// The design the website is working on: opening it, building and meshing its parts, editing their
// details, comparing a part with a CAD file of the real thing, and making the downloads. It has no page or worker code in it, so it runs (and is
// tested) in Node as well as in the browser's worker. OpenCASCADE must already be loaded.

import type { Shape3D } from "replicad";
import { strToU8, zipSync } from "fflate";
import { readOrk, type XmlDocument } from "../src/ork/read.ts";
import { allParts, buildModel, type Part, type RocketModel, type TransitionPart } from "../src/ork/model.ts";
import { setComment, type XmlTools } from "../src/ork/write.ts";
import { AUTO_KINDS, FeatureError, parseFeatures, type AutoKind } from "../src/features/parse.ts";
import { addAutoDetails } from "../src/features/auto.ts";
import { buildPart } from "../src/geometry/parts.ts";
import { solidVolume } from "../src/geometry/measure.ts";
import { findCompartments } from "../src/checks/compartments.ts";
import { printPieces, safeFileName, stepFile, stepOf, stepPieces, stlName, stlOf, type StepPiece } from "../src/export/files.ts";
import { PRINTED } from "../src/export/colors.ts";
import { reportText } from "../src/export/report.ts";
import { readCad } from "../src/match/cad.ts";
import { applyMatch, matchPart, matchText, type MatchResult } from "../src/match/compare.ts";
import { EGG_RADIUS, revsPerSecond, spinLoad, steadyRoll } from "../src/aero/roll.ts";
import { describeFeature } from "../src/features/describe.ts";
import { aboutPart, type PartAbout } from "../src/ork/about.ts";

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

/** A detail ork-cad added by itself (src/features/auto.ts). */
export interface AutoDetail {
  line: string;
  /** Which "@auto" setting turns it off. */
  kind: AutoKind;
  why: string;
  /** In plain words (src/features/describe.ts). */
  title: string;
  text: string;
  /** Its place among the part's details, to show it in 3D (detailShape). */
  index: number;
}

/** A detail line written in the part's comment, in plain words when it could be read. */
export interface WrittenDetail {
  line: string;
  title?: string;
  text?: string;
  /** Its place among the part's details, to show it in 3D; undefined if it isn't a detail that builds. */
  index?: number;
}

/** What a detail does to its part, to show in 3D: the plastic it takes away and the plastic it adds. */
export interface DetailShape {
  removed?: PartMesh;
  added?: PartMesh;
}

/** How fast canted fins spin the rocket (src/aero/roll.ts), at the top speed of a saved simulation. */
export interface SpinView {
  cantDegrees: number;
  /** m/s, and the simulation it's from (undefined: none saved with results, so a round speed). */
  speed: number;
  simulation?: string;
  revs: number;
  /** Push on the side of an egg, in g, and how far that is from the axis (mm). */
  load: number;
  eggRadius: number;
  /** Revolutions per second for each 10 m/s. */
  revsPer10: number;
}

export interface PartView {
  key: string;
  name: string;
  type: string;
  /** The detail lines (@...) of its comment. The rest of the comment is kept as it is. */
  details: string;
  /** The same lines, each in plain words. */
  written: WrittenDetail[];
  /** What the part is and where, in plain words. */
  about: PartAbout;
  /** Details ork-cad adds by itself, which a line of the same kind in `details` replaces. */
  auto: AutoDetail[];
  /** Why an automatic detail isn't there, e.g. the part would have to be solid. */
  autoNotes: string[];
  /** Automatic details the part's "@auto" lines turn off. */
  autoOff: AutoKind[];
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
  /** Canted fins: the spin they give. */
  spin?: SpinView;
  /** Fins printed as part of their tube: the tube's name (they have no shape of their own). */
  printedWith?: string;
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

export class Session {
  private solids = new Map<string, Shape3D[]>();
  private views = new Map<string, PartView>();
  /** The details each part was last built with, to know which to rebuild when they change. */
  private builtWith = new Map<string, string>();
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
    const model = buildModel(
      readOrk(bytes, (text) => xml.parse(text) as unknown as XmlDocument),
      { keepDetailErrors: true },
    );
    addAutoDetails(model);
    return model;
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
        // Show the part without the details written in (the automatic ones always fit) rather
        // than not at all.
        const features = part.features;
        part.features = features.filter((f) => f.auto);
        try {
          ({ solids, warnings } = buildPart(part, this.model)!);
        } finally {
          part.features = features;
        }
      }
    }
    for (const old of this.solids.get(key) ?? []) old.delete();
    this.solids.set(key, solids);
    this.builtWith.set(key, signature(part));

    const material = part.node?.fields.get("material");
    const density = Number(material?.attrs.density);
    const override = Number(part.node?.fields.get("overridemass")?.text);
    const view: PartView = {
      key,
      name: part.name,
      type: part.type,
      details: detailLines(part.comment).join("\n"),
      written: detailLines(part.comment).map((line) => writtenDetail(part, line)),
      about: aboutPart(part),
      auto: part.features.flatMap((f, index) =>
        f.auto ? [{ line: f.source, kind: autoKind(f.kind), why: f.auto, index, ...describeFeature(f, part) }] : [],
      ),
      autoNotes: part.autoNotes ?? [],
      autoOff: AUTO_KINDS.filter((k) => part.autoSettings?.[k] === false),
      material: material?.text ?? "",
      density: Number.isFinite(density) ? density : undefined,
      massOverride: Number.isFinite(override) ? override * 1000 : undefined,
      copies: part.instances.length,
      volume: solids.reduce((sum, s) => sum + solidVolume(s), 0),
      printed: PRINTED.test(material?.text ?? ""),
      warnings,
      errors,
      mesh: solids.length ? meshOf(solids) : undefined,
      spin: part.kind === "finset" && part.cant !== 0 ? this.spin(part) : undefined,
      printedWith: this.printedWith(part)?.name,
    };
    this.views.set(key, view);
    return view;
  }

  /** The tube fins are printed as part of (@one-piece), if they are. */
  private printedWith(part: Part): Part | undefined {
    if (part.kind !== "finset" || !part.features.some((f) => f.kind === "one-piece")) return undefined;
    return allParts(this.model).find((q) => q.children.includes(part));
  }

  /** The spin canted fins give, at the fastest top speed among the file's saved simulations. */
  private spin(part: Part & { kind: "finset" }): SpinView | undefined {
    const fastest = this.model.simulations
      .filter((s) => s.maxVelocity !== undefined)
      .sort((a, b) => b.maxVelocity! - a.maxVelocity!)[0];
    const speed = fastest?.maxVelocity ?? 50;
    const mach = fastest?.maxMach;
    let rate: number;
    try {
      rate = steadyRoll(part, speed, mach);
    } catch {
      return undefined;
    }
    return {
      cantDegrees: (part.cant * 180) / Math.PI,
      speed,
      simulation: fastest?.name,
      revs: revsPerSecond(rate),
      load: spinLoad(rate),
      eggRadius: EGG_RADIUS,
      revsPer10: revsPerSecond(rate) * (10 / speed),
    };
  }

  /**
   * Replaces a part's detail lines and rebuilds it, and any other part whose automatic details
   * change because of it (vents move to wherever the altimeter's space now needs them, say). Lines
   * that don't start with "@" are kept in the comment as plain notes. The edited part comes first.
   */
  setDetails(key: string, details: string): PartView[] {
    const part = this.part(key);
    const lines = details.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const detail = lines.filter((l) => l.startsWith("@"));
    const stray = lines.filter((l) => !l.startsWith("@"));
    const notes = part.comment.split(/\r?\n/).filter((l) => !l.trim().startsWith("@"));
    part.comment = [...notes, ...stray, ...detail].join("\n").trim();
    const { features, errors, auto } = parseFeatures(detail.join("\n"));
    part.features = features;
    part.autoSettings = auto;
    part.detailErrors = [...stray.map((l) => `"${l}" doesn't start with @, so it was kept as a plain note.`), ...errors];
    this.edited.add(key);
    addAutoDetails(this.model);
    const changed = this.parts.filter((p) => p !== part && this.builtWith.get(this.keyOf(p)) !== signature(p));
    return [part, ...changed].map((p) => this.build(p));
  }

  /**
   * What one of a part's details does, to show in 3D: the part built with it and without it, and
   * the difference both ways (holes and pockets take plastic away; a screw joint's collar and plug,
   * or printing solid, add it). Fins printed with their tube are shown as the fins themselves.
   */
  detailShape(key: string, index: number): DetailShape {
    const part = this.part(key);
    const f = part.features[index];
    if (!f) throw new Error(`${part.name} has no detail ${index + 1}; it may have changed.`);
    const without = { ...part, features: part.features.filter((g) => g !== f) } as Part;
    const plain = buildPart(without, this.model)?.solids ?? [];
    if (f.kind === "one-piece") return { added: plain.length ? meshOf(plain) : undefined };
    const built = this.solids.get(this.keyOf(part)) ?? [];
    const removed: Shape3D[] = [];
    const added: Shape3D[] = [];
    plain.forEach((p, i) => {
      const w = built[i];
      if (!w) return;
      const gone = p.cut(w);
      const extra = w.cut(p);
      if (solidVolume(gone) > 1e-6) removed.push(gone);
      if (solidVolume(extra) > 1e-6) added.push(extra);
    });
    return { removed: removed.length ? meshOf(removed) : undefined, added: added.length ? meshOf(added) : undefined };
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

  /**
   * One part as STL (one copy, for printing) or STEP (every copy in place, exact, for Onshape). A
   * tube with a screw joint is printed in two pieces, so its STL download is a zip of both.
   */
  async partFile(key: string, format: "stl" | "step"): Promise<FileOut> {
    const part = this.part(key);
    const solids = this.solids.get(key) ?? [];
    if (!solids.length) {
      const into = this.printedWith(part);
      throw new Error(into ? `${part.name} are printed as part of ${into.name}: download that.` : `${part.name} has no shape to export.`);
    }
    const base = safeFileName(part.name);
    if (format === "step") return { name: `${base}.step`, bytes: stepOf(part, solids) };
    const files = this.stlFiles(part, solids);
    if (files.length === 1) return files[0];
    return { name: `${base} (${files.length} pieces).zip`, bytes: zipSync(Object.fromEntries(files.map((f) => [f.name, f.bytes]))) };
  }

  /** A part's STL files: one copy of it, or of each piece it's printed in. */
  private stlFiles(part: Part, solids: Shape3D[]): (FileOut & { volume: number })[] {
    const split = solids.map((s) => printPieces(part, s));
    return split[0].map(({ name, shape }, k) => ({
      name: stlName(safeFileName(name), solids.length),
      bytes: stlOf(shape, name),
      volume: split.reduce((sum, pieces) => sum + solidVolume(pieces[k].shape), 0),
    }));
  }

  /**
   * The whole rocket as one STEP file for Onshape: every part (every copy of it) a separate, named
   * component with exact surfaces, in its place on the rocket.
   */
  rocketStep(): FileOut {
    const pieces: StepPiece[] = [];
    for (const part of this.parts) pieces.push(...stepPieces(part, this.solids.get(this.keyOf(part)) ?? []));
    if (!pieces.length) throw new Error("There are no parts to put in the file.");
    const name = safeFileName(this.rocket.fileName.replace(/\.ork$/i, "")) || "rocket";
    return { name: `${name} for Onshape.step`, bytes: stepFile(this.rocket.name, pieces) };
  }

  /** Every part as an STL for printing, and report.txt. */
  async zip(): Promise<FileOut> {
    const files: Record<string, Uint8Array> = {};
    const reportParts = [];
    let n = 0;
    for (const part of this.parts) {
      const key = this.keyOf(part);
      const view = this.views.get(key);
      const solids = this.solids.get(key);
      if (!solids?.length || !view) continue;
      const stls = this.stlFiles(part, solids);
      for (const stl of stls) {
        const fileName = `${String(++n).padStart(2, "0")} ${stl.name}`;
        files[fileName] = stl.bytes;
        // A mass typed into OpenRocket is for the whole tube, not one of its pieces.
        const massOverride = stls.length > 1 ? undefined : view.massOverride;
        reportParts.push({ ...view, fileName, volume: stl.volume, massOverride, details: view.details ? view.details.split("\n") : [] });
      }
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
    const result = matchPart(this.model, part, cad, fileName, { ...options, auto: true });
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
    this.builtWith.clear();
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

/**
 * What a part's build depends on beyond its OpenRocket fields: its details, and its notes about
 * them; for a body tube, also whether fins are printed as part of it.
 */
function signature(part: Part): string {
  const fins = part.children.filter((c) => c.kind === "finset" && c.features.some((f) => f.kind === "one-piece")).map((c) => c.id);
  return JSON.stringify([part.features.map((f) => [f.source, f.auto ?? ""]), part.autoNotes ?? [], part.detailErrors, fins]);
}

function writtenDetail(part: Part, line: string): WrittenDetail {
  if (/^@auto\b/i.test(line)) {
    const off = AUTO_KINDS.filter((k) => part.autoSettings?.[k] === false);
    return {
      line,
      title: "Automatic details turned off",
      text: off.length ? `ork-cad doesn't add these by itself on this part: ${off.map((k) => AUTO_WORDS[k]).join(", ")}.` : "Nothing is turned off.",
    };
  }
  const index = part.features.findIndex((f) => !f.auto && f.source === line);
  return index < 0 ? { line } : { line, index, ...describeFeature(part.features[index], part) };
}

/** The kinds of automatic detail, in words. */
const AUTO_WORDS: Record<AutoKind, string> = {
  solid: "printing solid",
  pocket: "the altimeter pocket",
  vents: "altimeter vents",
  "nut-trap": "the eyebolt nut",
  edges: "lead-ins on the shoulders",
  "one-piece": "printing the fins with their tube",
};

function autoKind(kind: string): AutoKind {
  return kind === "side-holes" ? "vents" : kind === "chamfer" || kind === "round" ? "edges" : (kind as AutoKind);
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
