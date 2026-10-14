// Turns the raw .ork tree into typed parts with absolute positions, following OpenRocket 24.12's
// rules (core/.../rocketcomponent). Units: millimetres and radians. Positions use OpenRocket's
// frame: x runs along the rocket axis from the nose tip toward the tail; y and z are radial,
// and an angle of 0 points along +y, increasing toward +z.

import { attributesOf, childElements, type OrkField, type OrkFile, type OrkNode } from "./read.ts";
import { FeatureError, parseFeatures, type AutoSettings, type Feature } from "../features/parse.ts";
import { transitionRadius } from "../geometry/shapes.ts";

export type ShapeType = "conical" | "ogive" | "ellipsoid" | "power" | "parabolic" | "haack";

/** One copy of a component in the rocket (fins and rail buttons have several). */
export interface Instance {
  /** Axial position of the instance's fore end, mm from the nose tip. */
  x: number;
  /** Radial offset of the instance's reference point from the rocket axis, mm. */
  y: number;
  z: number;
  /** Rotation about the rocket axis, radians. */
  angle: number;
}

interface PartBase {
  /** The .ork element name, e.g. "nosecone" or "ellipticalfinset". */
  type: string;
  name: string;
  id: string;
  comment: string;
  /** Length along the rocket axis, mm (root chord for fin sets). */
  length: number;
  instances: Instance[];
  children: Part[];
  /**
   * Details from the component's comment (holes...), see src/features/parse.ts, and the ones
   * ork-cad adds by itself (src/features/auto.ts), which have `auto` set.
   */
  features: Feature[];
  /** Comment lines that look like details but couldn't be read (only kept with keepDetailErrors). */
  detailErrors: string[];
  /** Which automatic details the comment's "@auto" lines leave on (all when there are none). */
  autoSettings?: AutoSettings;
  /** Why an automatic detail isn't there, e.g. the part would have to be solid. */
  autoNotes?: string[];
  node: OrkNode;
}

export interface Shoulder {
  radius: number;
  length: number;
  thickness: number;
  capped: boolean;
}

/** Nose cones and transitions: a shape of revolution between a fore and an aft radius. */
export interface TransitionPart extends PartBase {
  kind: "transition";
  shape: ShapeType;
  shapeParameter: number;
  clipped: boolean;
  foreRadius: number;
  aftRadius: number;
  /** Wall thickness, measured perpendicular to the surface (as in OpenRocket's mass model). */
  thickness: number;
  filled: boolean;
  foreShoulder: Shoulder;
  aftShoulder: Shoulder;
}

/** Body tubes, inner tubes, couplers, centering rings, bulkheads, engine blocks and launch lugs. */
export interface CylinderPart extends PartBase {
  kind: "cylinder";
  outerRadius: number;
  /** 0 for solid parts (bulkheads, filled tubes). */
  innerRadius: number;
}

export type FinOutline =
  | { shape: "trapezoid"; rootChord: number; tipChord: number; sweep: number; height: number }
  | { shape: "elliptical"; rootChord: number; height: number }
  | { shape: "freeform"; points: [number, number][] };

export interface FinSetPart extends PartBase {
  kind: "finset";
  finCount: number;
  thickness: number;
  crossSection: string;
  cant: number;
  outline: FinOutline;
  /** Tab below the root, in fin coordinates (x from the root's leading edge). */
  tab: { start: number; length: number; height: number } | null;
  /** How far OpenRocket's tab is from where the file's tab position puts it on this fin, mm (see finTab). */
  tabMoved: number;
  filletRadius: number;
  /** Radius of the body tube at the fin root, mm. */
  bodyRadius: number;
}

export interface RailButtonPart extends PartBase {
  kind: "railbutton";
  outerDiameter: number;
  innerDiameter: number;
  height: number;
  baseHeight: number;
  flangeHeight: number;
  screwHeight: number;
}

/** Mass components, recovery gear, stages and anything else without printable geometry. */
export interface OtherPart extends PartBase {
  kind: "other";
}

/** A component the tool can't build yet (pods, tube fins, canted fins...): reported, not built. */
export interface UnsupportedPart extends PartBase {
  kind: "unsupported";
  reason: string;
}

export type Part = TransitionPart | CylinderPart | FinSetPart | RailButtonPart | OtherPart | UnsupportedPart;

export interface RocketModel {
  name: string;
  /**
   * The rocket's length as OpenRocket gives it, mm: from the foremost to the aftmost point of any
   * part, so a motor tube or fins reaching past the airframe count. The CAD frame puts the nose
   * tip at Z = length, as OpenRocket's OBJ export does.
   */
  length: number;
  /** Nose tip to the aft end of the last body tube, nose cone or transition, mm. */
  bodyLength: number;
  /** Stages in order; their children are the body components. */
  stages: Part[];
  creator: string;
  formatVersion: string;
}

const M = 1000; // metres to millimetres
const DEG = Math.PI / 180;
const BODY_TAGS = new Set(["nosecone", "transition", "bodytube"]);

export class UnsupportedError extends Error {}

/**
 * keepDetailErrors: by default a detail line that can't be read stops everything (right for the
 * command line); the website instead keeps going and shows each problem next to its part.
 */
export function buildModel(file: OrkFile, options: { keepDetailErrors?: boolean } = {}): RocketModel {
  const rocket = file.rocket;
  for (const stageNode of rocket.children) {
    if (stageNode.tag !== "stage") {
      throw new UnsupportedError(`<${stageNode.tag}> at the top of the rocket isn't supported yet (only stages).`);
    }
    for (const node of stageNode.children) {
      if (!BODY_TAGS.has(node.tag)) {
        throw new UnsupportedError(
          `"${text(node, "name")}" (<${node.tag}>) sits directly in a stage; only nose cones, body tubes and transitions can.`,
        );
      }
    }
  }
  // "Auto" radii come from neighbouring body components, also across stages.
  const radii = bodyRadii(rocket.children.flatMap((s) => s.children));
  const stages: Part[] = [];
  let x = 0;
  let k = 0;
  for (const stageNode of rocket.children) {
    const stage = otherPart(stageNode, 0, []);
    // Body components are stacked one after another.
    let bodyX = x;
    for (const node of stageNode.children) {
      const part = bodyPart(node, radii[k++]);
      part.instances = [{ x: bodyX, y: 0, z: 0, angle: 0 }];
      bodyX += part.length;
      stage.children.push(part);
    }
    stage.length = bodyX - x;
    stage.instances = [{ x, y: 0, z: 0, angle: 0 }];
    x = bodyX;
    stages.push(stage);
    // Inner components need their parent's final position, so they are placed afterwards.
    for (const body of stage.children) placeChildren(body);
  }
  const model: RocketModel = {
    name: text(rocket, "name"),
    length: 0,
    bodyLength: x,
    stages,
    creator: file.creator,
    formatVersion: file.formatVersion,
  };
  model.length = rocketLength(model);
  const problems: string[] = [];
  for (const part of allParts(model)) {
    const { features, errors, auto } = parseFeatures(part.comment);
    part.features = features;
    part.detailErrors = errors;
    part.autoSettings = auto;
    problems.push(...errors.map((e) => `${part.name}: ${e}`));
  }
  if (problems.length && !options.keepDetailErrors) {
    throw new FeatureError(`Problems in component comments:\n  ${problems.join("\n  ")}`);
  }
  return model;
}

/** Every part in the rocket, depth first in file order. */
export function allParts(model: RocketModel): Part[] {
  const out: Part[] = [];
  const visit = (p: Part) => {
    out.push(p);
    p.children.forEach(visit);
  };
  model.stages.forEach(visit);
  return out;
}

const MASS_OBJECT_TAGS = new Set(["masscomponent", "parachute", "streamer", "shockcord"]);

/**
 * The rocket's length as OpenRocket 24.12 works it out (FlightConfiguration.calculateBounds): the
 * span of every component's bounding box along the axis. Fins count their whole outline and rail
 * buttons their diameter. Mass components, parachutes and shock cords are added before OpenRocket
 * moves them into place, so they count as reaching from the nose tip to their own length.
 */
function rocketLength(model: RocketModel): number {
  let min = Infinity;
  let max = -Infinity;
  const span = (a: number, b: number) => {
    min = Math.min(min, a);
    max = Math.max(max, b);
  };
  for (const p of allParts(model)) {
    if (p.kind === "transition" || p.kind === "cylinder") {
      for (const i of p.instances) span(i.x, i.x + p.length);
    } else if (p.kind === "finset") {
      const xs = finOutlineX(p.outline);
      for (const i of p.instances) span(i.x + Math.min(...xs), i.x + Math.max(...xs));
    } else if (p.kind === "railbutton") {
      for (const i of p.instances) span(i.x - p.outerDiameter / 2, i.x + p.outerDiameter / 2);
    } else if (p.kind === "other" && MASS_OBJECT_TAGS.has(p.type)) {
      span(0, p.length);
    }
  }
  return max > min ? max - min : 0;
}

/** The x of a fin outline's corners (OpenRocket's getFinPoints), from the root's leading edge. */
function finOutlineX(o: FinOutline): number[] {
  switch (o.shape) {
    case "trapezoid":
      return [0, o.sweep, ...(o.tipChord > 0.1 ? [o.sweep + o.tipChord] : []), Math.max(o.rootChord, 0.1)];
    case "elliptical":
      return [0, Math.max(o.rootChord, 0.1)];
    case "freeform":
      return o.points.map((p) => p[0]);
  }
}

// ---------------------------------------------------------------------------------------------
// Body components

function bodyPart(node: OrkNode, radii: Radii): Part {
  try {
    switch (node.tag) {
      case "nosecone":
        return transitionPart(node, true, radii);
      case "transition":
        return transitionPart(node, false, radii);
      default: {
        const outer = radii.fore;
        if (!(outer >= 0)) throw new UnsupportedError(`Can't work out the radius of "${text(node, "name")}".`);
        const { filled, thickness } = wall(node);
        const part: CylinderPart = {
          ...base(node, length(node, "length")),
          kind: "cylinder",
          outerRadius: outer,
          innerRadius: filled ? 0 : Math.max(0, outer - thickness),
        };
        return part;
      }
    }
  } catch (e) {
    // Still stack it at its length, so the parts after it land in the right place.
    if (e instanceof UnsupportedError) return unsupported(node, optLength(node, "length") ?? 0, e.message);
    throw e;
  }
}

/**
 * Wall thickness, or solid: ticking "Filled" in OpenRocket saves the thickness as the word "filled"
 * (SymmetricComponent's setFilled in OpenRocket's DocumentConfig).
 */
function wall(node: OrkNode): { filled: boolean; thickness: number } {
  if (text(node, "thickness").toLowerCase() === "filled") return { filled: true, thickness: 0 };
  return { filled: bool(node, "filled"), thickness: optLength(node, "thickness") ?? 0 };
}

function transitionPart(node: OrkNode, isNoseCone: boolean, radii: Radii): TransitionPart {
  const name = text(node, "name");
  if (isNoseCone && bool(node, "isflipped")) {
    throw new UnsupportedError(`"${name}" is a flipped nose cone (tail cone), which isn't supported yet.`);
  }
  const shape = text(node, "shape") as ShapeType;
  if (!["conical", "ogive", "ellipsoid", "power", "parabolic", "haack"].includes(shape)) {
    throw new UnsupportedError(`"${name}" has an unknown shape "${shape}".`);
  }
  const shoulder = (side: "fore" | "aft"): Shoulder => ({
    radius: optLength(node, `${side}shoulderradius`) ?? 0,
    length: optLength(node, `${side}shoulderlength`) ?? 0,
    thickness: optLength(node, `${side}shoulderthickness`) ?? 0,
    capped: bool(node, `${side}shouldercapped`),
  });
  const { fore: foreRadius, aft: aftRadius } = radii;
  if (!(foreRadius >= 0 && aftRadius >= 0)) throw new UnsupportedError(`Can't work out the radii of "${name}".`);
  const { filled, thickness } = wall(node);
  return {
    ...base(node, length(node, "length")),
    kind: "transition",
    shape,
    shapeParameter: optNumber(node, "shapeparameter") ?? defaultShapeParameter(shape),
    clipped: bool(node, "shapeclipped"),
    foreRadius,
    aftRadius,
    thickness,
    filled,
    foreShoulder: isNoseCone ? { radius: 0, length: 0, thickness: 0, capped: false } : shoulder("fore"),
    aftShoulder: shoulder("aft"),
  };
}

/** OpenRocket's Transition.Shape default parameters. */
function defaultShapeParameter(shape: ShapeType): number {
  switch (shape) {
    case "ogive":
    case "parabolic":
      return 1;
    case "power":
      return 0.5;
    default:
      return 0;
  }
}

interface Radii {
  fore: number;
  aft: number;
}

const DEFAULT_RADIUS = 25; // mm (SymmetricComponent.DEFAULT_RADIUS)

/**
 * The fore and aft radius of every body component, nose to tail across all stages, with "auto"
 * radii worked out as OpenRocket 24.12 does (BodyTube.getAutoOuterRadius, Transition.getAutoForeRadius
 * and getAutoAftRadius, including BodyTube's memory of which neighbour it last took its radius
 * from). An auto end takes the radius of the nearest fixed end in that direction, looking through
 * auto body tubes. The number OpenRocket writes after "auto" is only what the radius was when the
 * file was saved, which can be out of date; OpenRocket doesn't use it and neither does this.
 * NaN marks a radius missing from the file.
 */
function bodyRadii(bodies: OrkNode[]): Radii[] {
  const links = bodies.map((node) => {
    if (node.tag === "bodytube") {
      const r = radiusField(node, "radius");
      return { tube: true, foreAuto: r.auto, aftAuto: r.auto, fore: r.value, aft: r.value, ref: null as number | null };
    }
    const aft = radiusField(node, "aftradius");
    // A nose cone's tip has radius 0; flipped (a tail cone), its base is the fore end.
    const tip = { auto: false, value: 0 };
    const [fore, aftEnd] =
      node.tag !== "nosecone" ? [radiusField(node, "foreradius"), aft] : bool(node, "isflipped") ? [aft, tip] : [tip, aft];
    return { tube: false, foreAuto: fore.auto, aftAuto: aftEnd.auto, fore: fore.value, aft: aftEnd.value, ref: null as number | null };
  });
  const last = links.length - 1;
  // usesPreviousCompAutomatic / usesNextCompAutomatic
  const usesPrevious = (i: number) => links[i].foreAuto && (!links[i].tube || links[i].ref === i - 1);
  const usesNext = (i: number) => links[i].aftAuto && (!links[i].tube || links[i].ref === i + 1);
  // getFrontAutoRadius / getRearAutoRadius: the radius offered to the neighbour behind / in front,
  // or -1 for none.
  const frontAuto = (i: number): number => {
    const l = links[i];
    if (l.tube && l.aftAuto) return i > 0 ? frontAuto(i - 1) : -1;
    return l.aftAuto ? -1 : l.aft;
  };
  const rearAuto = (i: number): number => {
    const l = links[i];
    if (l.tube && l.foreAuto) return i < last ? rearAuto(i + 1) : -1;
    return l.foreAuto ? -1 : l.fore;
  };
  // Twice, in file order, so each tube's memory of its neighbours has settled.
  for (let pass = 0; pass < 2; pass++) {
    links.forEach((l, i) => {
      if (l.tube) {
        if (!l.foreAuto) return;
        let r = -1;
        if (i > 0 && !usesNext(i - 1)) {
          r = frontAuto(i - 1);
          l.ref = i - 1;
        }
        if (r < 0 && i < last && !usesPrevious(i + 1)) {
          r = rearAuto(i + 1);
          l.ref = i + 1;
        }
        l.fore = l.aft = r < 0 ? DEFAULT_RADIUS : r;
        return;
      }
      if (l.foreAuto) l.fore = i > 0 ? frontAuto(i - 1) : DEFAULT_RADIUS;
      if (l.aftAuto) l.aft = i < last ? rearAuto(i + 1) : DEFAULT_RADIUS;
    });
  }
  return links.map((l) => ({ fore: l.fore, aft: l.aft }));
}

// ---------------------------------------------------------------------------------------------
// Inner components

function placeChildren(parent: Part): void {
  // What's inside something unsupported (a pod's tubes and fins...) isn't placed either.
  if (parent.kind === "unsupported") return;
  parent.children = parent.node.children.map((node) => innerPart(node, parent));
  for (const child of parent.children) placeChildren(child);
}

/** Interprets an inner component; one the tool can't build yet becomes an UnsupportedPart. */
function innerPart(node: OrkNode, parent: Part): Part {
  try {
    return supportedInnerPart(node, parent);
  } catch (e) {
    if (!(e instanceof UnsupportedError)) throw e;
    const part = unsupported(node, 0, e.message);
    part.instances = [{ x: parent.instances[0].x, y: 0, z: 0, angle: 0 }];
    return part;
  }
}

const UNSUPPORTED_TAGS: Record<string, string> = {
  podset: "pods",
  parallelstage: "side boosters",
  tubefinset: "tube fins",
};

function supportedInnerPart(node: OrkNode, parent: Part): Part {
  const name = text(node, "name");
  const parentX = parent.instances[0].x;
  if (parent.instances.length > 1) {
    throw new UnsupportedError(`"${name}" is inside a component with several copies, which isn't supported yet.`);
  }
  if (node.tag in UNSUPPORTED_TAGS) {
    throw new UnsupportedError(`"${name}" is ${UNSUPPORTED_TAGS[node.tag]}, which aren't supported yet.`);
  }
  switch (node.tag) {
    case "innertube":
    case "tubecoupler":
    case "engineblock":
    case "centeringring":
    case "bulkhead": {
      const len = length(node, "length");
      const [outer, inner] = ringRadii(node, parent);
      const part: CylinderPart = { ...base(node, len), kind: "cylinder", outerRadius: outer, innerRadius: inner };
      if (node.tag === "innertube") {
        const cluster = text(node, "clusterconfiguration") || "single";
        if (cluster !== "single") {
          throw new UnsupportedError(`"${name}" is a ${cluster} motor cluster, which isn't supported yet.`);
        }
      }
      const r = optLength(node, "radialposition") ?? 0;
      const dir = (optNumber(node, "radialdirection") ?? 0) * DEG;
      const x = parentX + axialPosition(node, len, parent);
      part.instances = repeat(node, x, (i, xi) => ({ x: xi, y: r * Math.cos(dir), z: r * Math.sin(dir), angle: 0 }));
      return part;
    }
    case "launchlug": {
      const len = length(node, "length");
      const outer = length(node, "radius");
      const part: CylinderPart = {
        ...base(node, len),
        kind: "cylinder",
        outerRadius: outer,
        innerRadius: Math.max(0, outer - length(node, "thickness")),
      };
      const angle = angleOffset(node);
      const r = bodyRadiusAt(parent, name) + outer + radiusOffset(node);
      const x = parentX + axialPosition(node, len, parent);
      part.instances = repeat(node, x, (_i, xi) => ({
        x: xi,
        y: r * Math.cos(angle),
        z: r * Math.sin(angle),
        angle,
      }));
      return part;
    }
    case "railbutton": {
      // OpenRocket gives rail buttons zero length for positioning.
      const part: RailButtonPart = {
        ...base(node, 0),
        kind: "railbutton",
        outerDiameter: length(node, "outerdiameter"),
        innerDiameter: length(node, "innerdiameter"),
        height: length(node, "height"),
        baseHeight: length(node, "baseheight"),
        flangeHeight: length(node, "flangeheight"),
        screwHeight: optLength(node, "screwheight") ?? 0,
      };
      const angle = angleOffset(node);
      const r = bodyRadiusAt(parent, name) + radiusOffset(node);
      const x = parentX + axialPosition(node, 0, parent);
      part.instances = repeat(node, x, (_i, xi) => ({
        x: xi,
        y: r * Math.cos(angle),
        z: r * Math.sin(angle),
        angle,
      }));
      return part;
    }
    case "trapezoidfinset":
    case "ellipticalfinset":
    case "freeformfinset":
      return finSet(node, parent);
    default: {
      // Mass components, parachutes, streamers, shock cords and anything unknown: no geometry.
      const len = packedLength(node, parent);
      const part = otherPart(node, len, []);
      part.instances = [{ x: parentX + axialPosition(node, len, parent), y: 0, z: 0, angle: 0 }];
      return part;
    }
  }
}

function finSet(node: OrkNode, parent: Part): FinSetPart {
  const name = text(node, "name");
  if (parent.kind !== "cylinder" || parent.type !== "bodytube") {
    throw new UnsupportedError(`"${name}" is attached to a ${parent.type}; fins are only supported on body tubes so far.`);
  }
  let outline: FinOutline;
  if (node.tag === "trapezoidfinset") {
    outline = {
      shape: "trapezoid",
      rootChord: length(node, "rootchord"),
      tipChord: length(node, "tipchord"),
      sweep: length(node, "sweeplength"),
      height: length(node, "height"),
    };
  } else if (node.tag === "ellipticalfinset") {
    outline = { shape: "elliptical", rootChord: length(node, "rootchord"), height: length(node, "height") };
  } else {
    const pointsEl = node.complex.get("finpoints");
    const points: [number, number][] = [];
    if (pointsEl) {
      for (let i = 0; i < pointsEl.childNodes.length; i++) {
        const p = pointsEl.childNodes[i] as unknown as { nodeType: number; getAttribute(n: string): string | null };
        if (p.nodeType !== 1) continue;
        points.push([Number(p.getAttribute("x")) * M, Number(p.getAttribute("y")) * M]);
      }
    }
    if (points.length < 3) throw new UnsupportedError(`"${name}" has fewer than 3 fin points.`);
    // OpenRocket moves the points so the first one is at the origin (FreeformFinSet.setPoints).
    const [x0, y0] = points[0];
    outline = { shape: "freeform", points: points.map(([px, py]) => [px - x0, py - y0]) };
  }
  // A freeform fin set's length is its last point's x, even where the outline reaches further
  // aft than the root (FreeformFinSet.update).
  const rootChord = outline.shape === "freeform" ? outline.points[outline.points.length - 1][0] : outline.rootChord;

  const finCount = Math.round(optNumber(node, "fincount") ?? optNumber(node, "instancecount") ?? 1);
  const { tab, tabMoved } = finTab(node, outline.shape, rootChord);
  const radiusMethod = node.fields.get("radiusoffset")?.attrs.method ?? "surface";
  if (radiusMethod !== "surface") {
    throw new UnsupportedError(`"${name}" uses a "${radiusMethod}" radius offset; only "surface" is supported so far.`);
  }
  const bodyRadius = bodyRadiusAt(parent, name) + radiusOffset(node);
  const part: FinSetPart = {
    ...base(node, rootChord),
    kind: "finset",
    finCount,
    thickness: length(node, "thickness"),
    crossSection: text(node, "crosssection") || "square",
    cant: (optNumber(node, "cant") ?? 0) * DEG,
    outline,
    tab,
    tabMoved,
    filletRadius: optLength(node, "filletradius") ?? 0,
    bodyRadius,
  };
  const x = parent.instances[0].x + axialPosition(node, rootChord, parent);
  const angle0 = node.fields.has("angleoffset") ? angleOffset(node) : (optNumber(node, "rotation") ?? 0) * DEG;
  part.instances = [];
  for (let i = 0; i < finCount; i++) {
    const angle = angle0 + (2 * Math.PI * i) / finCount;
    part.instances.push({ x, y: bodyRadius * Math.cos(angle), z: bodyRadius * Math.sin(angle), angle });
  }
  return part;
}

/** Outer and inner radius of ring-shaped inner components, resolving OpenRocket's "auto" sizes. */
function ringRadii(node: OrkNode, parent: Part): [number, number] {
  const name = text(node, "name");
  const outer = ringOuterRadius(node, parent);
  if (!(outer >= 0)) throw new UnsupportedError(`Can't work out the outer radius of "${name}".`);
  switch (node.tag) {
    case "innertube":
    case "tubecoupler":
    case "engineblock":
      return [outer, Math.max(0, outer - length(node, "thickness"))];
    case "bulkhead":
      return [outer, 0];
    default: {
      // Centering ring: an "auto" inner radius is the largest inner tube next to it (a sibling)
      // that overlaps it along the axis, as in OpenRocket's CenteringRing.getInnerRadius.
      const f = radiusField(node, "innerradius");
      if (!f.auto) return [outer, f.value];
      const len = length(node, "length");
      const r0 = axialPosition(node, len, parent);
      let inner = 0;
      for (const sibling of parent.node.children) {
        if (sibling.tag !== "innertube") continue;
        const tubeLength = length(sibling, "length");
        const t0 = axialPosition(sibling, tubeLength, parent);
        if (r0 + len < t0 || r0 > t0 + tubeLength) continue;
        inner = Math.max(inner, ringOuterRadius(sibling, parent));
      }
      return [outer, Math.min(inner, outer)];
    }
  }
}

/**
 * Outer radius of a ring, tube coupler, bulkhead or inner tube. "Auto" makes it fit inside the
 * parent: the smaller of the parent's inside radii at the part's two ends (OpenRocket's
 * RadiusRingComponent / ThicknessRingComponent.getOuterRadius). Only body tubes, nose cones,
 * transitions, inner tubes and couplers fit things this way; inside anything else OpenRocket keeps
 * the radius in the file.
 */
function ringOuterRadius(node: OrkNode, parent: Part): number {
  const f = radiusField(node, "outerradius");
  if (!f.auto) return f.value;
  if (parent.kind === "cylinder" && ["bodytube", "innertube", "tubecoupler"].includes(parent.type)) {
    return parent.innerRadius;
  }
  if (parent.kind !== "transition") return f.value;
  if (parent.filled) {
    throw new UnsupportedError(`"${text(node, "name")}" is sized "auto" inside a solid ${parent.type}.`);
  }
  const len = length(node, "length");
  const s = axialPosition(node, len, parent);
  // Transition.getInnerRadius: the outside radius less the wall thickness, measured radially.
  const insideAt = (x: number) => {
    const at = Math.min(Math.max(x, 0), parent.length);
    return Math.max(transitionRadius(parent, at) - parent.thickness, 0);
  };
  return Math.min(insideAt(s), insideAt(s + len));
}

/**
 * Packed length of a mass component, parachute, streamer or shock cord. With an "auto" packed
 * radius, OpenRocket widens or narrows the pack to fill its parent and keeps its volume, so the
 * length changes (MassObject.getAutoLength). That volume is the radius written after "auto" (or
 * OpenRocket's default 12.5 mm) squared, times the length in the file.
 */
function packedLength(node: OrkNode, parent: Part): number {
  const len = optLength(node, "packedlength") ?? optLength(node, "length") ?? 0;
  const f = node.fields.get("packedradius");
  if (!f) return len;
  const r = radiusField(node, "packedradius");
  if (!r.auto) return len;
  const r0 = Number.isFinite(r.value) ? r.value : 12.5;
  const fit = parentPackRadius(parent);
  return fit === 0 ? len : (r0 * r0 * len) / (fit * fit);
}

/** MassObject.getMaxParentRadius: how wide an "auto" pack is inside this parent (0: not set). */
function parentPackRadius(parent: Part): number {
  if (parent.kind === "transition") {
    return parent.type === "nosecone" ? parent.aftRadius : Math.max(parent.foreRadius, parent.aftRadius);
  }
  if (parent.kind === "cylinder" && parent.type !== "launchlug") return parent.innerRadius;
  return 0;
}

/** Radius of the body tube surface a fin, lug or rail button is mounted on. */
function bodyRadiusAt(parent: Part, childName: string): number {
  if (parent.kind === "cylinder" && (parent.type === "bodytube" || parent.type === "innertube")) {
    return parent.outerRadius;
  }
  throw new UnsupportedError(`"${childName}" is mounted on a ${parent.type}; only body tubes are supported so far.`);
}

/** Axial position of a component's fore end relative to its parent's fore end (OpenRocket AxialMethod). */
function axialPosition(node: OrkNode, ownLength: number, parent: Part): number {
  const f = node.fields.get("axialoffset") ?? node.fields.get("position");
  if (!f) return 0;
  const offset = Number(f.text) * M;
  const method = f.attrs.method ?? f.attrs.type ?? "top";
  switch (method) {
    case "top":
      return offset;
    case "middle":
      return offset + (parent.length - ownLength) / 2;
    case "bottom":
      return offset + (parent.length - ownLength);
    case "after":
      return parent.length + offset;
    case "absolute":
      return offset - parent.instances[0].x;
    default:
      throw new UnsupportedError(`"${text(node, "name")}" uses an unknown axial position method "${method}".`);
  }
}

/** Copies along the axis (rail buttons, launch lugs, rings): instancecount and instanceseparation. */
function repeat(node: OrkNode, x: number, make: (i: number, x: number) => Instance): Instance[] {
  const count = Math.max(1, Math.round(optNumber(node, "instancecount") ?? 1));
  const sep = optLength(node, "instanceseparation") ?? 0;
  return Array.from({ length: count }, (_, i) => make(i, x + i * sep));
}

function angleOffset(node: OrkNode): number {
  const f = node.fields.get("angleoffset") ?? node.fields.get("radialdirection");
  return f ? Number(f.text) * DEG : 0;
}

function radiusOffset(node: OrkNode): number {
  const f = node.fields.get("radiusoffset");
  if (!f) return 0;
  if ((f.attrs.method ?? "surface") !== "surface") {
    throw new UnsupportedError(`"${text(node, "name")}" uses a "${f.attrs.method}" radius offset; only "surface" is supported so far.`);
  }
  return Number(f.text) * M;
}

// ---------------------------------------------------------------------------------------------
// Field helpers

function base(node: OrkNode, len: number): PartBase {
  return {
    type: node.tag,
    name: text(node, "name"),
    id: text(node, "id"),
    comment: text(node, "comment"),
    length: len,
    instances: [],
    children: [],
    features: [],
    detailErrors: [],
    node,
  };
}

function otherPart(node: OrkNode, len: number, children: Part[]): OtherPart {
  return { ...base(node, len), kind: "other", children };
}

function unsupported(node: OrkNode, len: number, reason: string): UnsupportedPart {
  return { ...base(node, len), kind: "unsupported", reason };
}

function field(node: OrkNode, name: string): OrkField | undefined {
  return node.fields.get(name);
}

function text(node: OrkNode, name: string): string {
  return field(node, name)?.text ?? "";
}

type TabMethod = "absolute" | "after" | "top" | "middle" | "bottom";

/** AxialMethod.getAsPosition: where a tab `inner` long starts on a fin `outer` long. */
function tabStart(method: TabMethod, offset: number, inner: number, outer: number): number {
  switch (method) {
    case "absolute":
    case "top":
      return offset;
    case "after":
      return outer + offset;
    case "middle":
      return offset + (outer - inner) / 2;
    case "bottom":
      return offset + (outer - inner);
  }
}

/**
 * The fin tab as OpenRocket has it after opening the file, by replaying how it reads one (FinSet,
 * FinTabPositionSetter, FinSetPointHandler). It works out where the tab starts from the fin's
 * length at the moment it reads <tablength> and each <tabposition>, and files have those before the
 * root chord or fin points, so at that moment the fin still has its default 50 mm length. Trapezoidal
 * and freeform fin sets place the tab again once their size is read; elliptical ones don't
 * (OpenRocket 24.12), so their tab stays where it would be on a 50 mm fin, only shortened if it then
 * runs past the root's end. tabMoved is how far that puts an elliptical fin's tab from where its
 * saved position says.
 */
function finTab(node: OrkNode, shape: FinOutline["shape"], finLength: number): { tab: FinSetPart["tab"]; tabMoved: number } {
  const SAME = 1e-8 * M; // OpenRocket's MathUtil.EPSILON
  let method: TabMethod = "middle";
  let offset = 0;
  let tabLength = 0.05 * M;
  let savedLength = tabLength;
  let start = 0;
  let length = 0.05 * M;
  const place = () => (start = tabStart(method, offset, tabLength, length));
  // FinSet.validateFinTabLength
  const shorten = () => {
    if (length < start + tabLength) tabLength -= start + tabLength - length;
    tabLength = Math.max(0, tabLength);
  };
  for (const el of childElements(node.element)) {
    if (el.tagName === "finpoints") {
      // FreeformFinSet.setPoints makes the fin's length the last point's x and shortens the tab if
      // needed; then the loader places the tab again.
      if (shape === "freeform") {
        if (finLength !== length) {
          length = finLength;
          shorten();
        }
        place();
      }
      continue;
    }
    const v = Number((el.textContent ?? "").trim()) * M;
    if (!Number.isFinite(v)) continue;
    if (el.tagName === "tablength" && Math.abs(tabLength - Math.max(v, 0)) >= SAME) {
      tabLength = savedLength = v;
      place();
    } else if (el.tagName === "tabposition") {
      // Older files name the reference point front/center/end.
      const rel = (attributesOf(el).relativeto ?? "").trim();
      const m = rel.includes("front") ? "top" : rel.includes("center") ? "middle" : rel.includes("end") ? "bottom" : rel;
      if (!["absolute", "after", "top", "middle", "bottom"].includes(m)) continue;
      method = m as TabMethod;
      offset = v;
      place();
    } else if (el.tagName === "rootchord" && shape === "trapezoid") {
      if (length !== Math.max(v, 0)) {
        length = Math.max(v, 0);
        place();
      }
    } else if (el.tagName === "rootchord" && shape === "elliptical") {
      if (Math.abs(length - v) >= SAME) {
        length = v;
        shorten();
      }
    }
  }
  const height = optLength(node, "tabheight") ?? 0;
  if (!(height > 0 && tabLength > 0)) return { tab: null, tabMoved: 0 };
  const tabMoved = shape === "elliptical" ? start - tabStart(method, offset, savedLength, finLength) : 0;
  return { tab: { start, length: tabLength, height }, tabMoved };
}

function bool(node: OrkNode, name: string): boolean {
  return text(node, name) === "true";
}

function optNumber(node: OrkNode, name: string): number | undefined {
  const f = field(node, name);
  if (!f || f.text === "") return undefined;
  const v = Number(f.text);
  if (!Number.isFinite(v)) throw new Error(`"${text(node, "name")}": <${name}> isn't a number ("${f.text}").`);
  return v;
}

/** A length in the file (metres), returned in millimetres. */
function optLength(node: OrkNode, name: string): number | undefined {
  const v = optNumber(node, name);
  return v === undefined ? undefined : v * M;
}

function length(node: OrkNode, name: string): number {
  const v = optLength(node, name);
  if (v === undefined) throw new Error(`"${text(node, "name")}" is missing <${name}>.`);
  return v;
}

/**
 * A radius that may be "auto", in mm. OpenRocket 23.09+ writes the radius it had when the file
 * was saved after the word ("auto 0.0281559"), older versions only "auto". value is NaN when no
 * number is given.
 */
function radiusField(node: OrkNode, name: string): { auto: boolean; value: number } {
  const words = text(node, name).trim().split(/\s+/);
  const auto = words[0].toLowerCase() === "auto";
  const v = auto ? words[1] : words[0];
  return { auto, value: v === undefined || v === "" ? NaN : Number(v) * M };
}
