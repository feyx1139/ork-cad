// What each part is, in plain words, for the website: "Body tube, 66 mm across, 305 mm long",
// what it's for, and where it sits on the rocket.

import { isFilled, type Part } from "./model.ts";

export interface PartAbout {
  /** What it is, with its main sizes: "Fin set: 4 elliptical fins". */
  label: string;
  /** What it's for, in a sentence. */
  about: string;
  /** Where it is along the rocket, mm from the nose tip (fore and aft end). */
  from: number;
  to: number;
}

const SHAPES: Record<string, string> = {
  conical: "cone",
  ogive: "ogive",
  ellipsoid: "elliptical",
  power: "power-series",
  parabolic: "parabolic",
  haack: "Haack",
};

export function aboutPart(part: Part): PartAbout {
  const from = Math.min(...part.instances.map((i) => i.x));
  const where = { from, to: from + part.length };
  const across = (r: number) => `${mm(2 * r)} mm across`;
  switch (part.kind) {
    case "transition": {
      const solid = isFilled(part) ? "solid" : `${mm(part.thickness)} mm wall`;
      if (part.type === "nosecone") {
        return {
          label: `Nose cone: ${SHAPES[part.shape] ?? part.shape}, ${across(part.aftRadius)}, ${mm(part.length)} mm long`,
          about: `The pointed front of the rocket (${solid}). Its shoulder slides into the tube behind it.`,
          ...where,
        };
      }
      const same = Math.abs(part.foreRadius - part.aftRadius) < 1e-6;
      return {
        label: same
          ? `Band: ${across(part.foreRadius)}, ${mm(part.length)} mm long`
          : `Transition: ${mm(2 * part.foreRadius)} mm to ${mm(2 * part.aftRadius)} mm across, ${mm(part.length)} mm long`,
        about: same
          ? `A short piece the same size at both ends (${solid}), with shoulders that slide into the tubes on either side.`
          : `Joins tubes of different sizes (${solid}): the top end fits the tube in front, the bottom end the one behind.`,
        ...where,
      };
    }
    case "cylinder": {
      const size = `${across(part.outerRadius)}${part.innerRadius > 0 ? ` (${mm(2 * part.innerRadius)} inside)` : ""}, ${mm(part.length)} mm long`;
      switch (part.type) {
        case "bodytube":
          return { label: `Body tube: ${size}`, about: "Part of the outside of the rocket.", ...where };
        case "innertube": {
          const motor = part.node?.complex.has("motormount");
          return motor
            ? { label: `Motor tube: ${size}`, about: "Holds the motor, in the middle of the body tube.", ...where }
            : { label: `Inner tube: ${size}`, about: "A tube inside the body tube.", ...where };
        }
        case "tubecoupler":
          return { label: `Coupler: ${size}`, about: "A short tube inside two body tubes that joins them end to end.", ...where };
        case "centeringring":
          return { label: `Centering ring: ${size}`, about: "Holds the motor tube in the middle of the body tube.", ...where };
        case "bulkhead":
          return { label: `Bulkhead: ${across(part.outerRadius)}, ${mm(part.length)} mm thick`, about: "A disc that closes off the inside of the tube.", ...where };
        case "engineblock":
          return { label: `Engine block: ${size}`, about: "A ring that stops the motor sliding forward when it fires.", ...where };
        case "launchlug":
          return { label: `Launch lug: ${size}`, about: "A small tube on the outside that slides on the launch rod.", ...where };
        default:
          return { label: `${part.type}: ${size}`, about: "", ...where };
      }
    }
    case "finset": {
      const o = part.outline;
      const shape = o.shape === "trapezoid" ? "trapezoidal" : o.shape === "elliptical" ? "elliptical" : "freeform";
      const height = o.shape === "freeform" ? Math.max(...o.points.map(([, y]) => y)) : o.height;
      const n = part.instances.length;
      const cant = part.cant !== 0 ? `, canted ${mm(Math.abs((part.cant * 180) / Math.PI))}°` : "";
      return {
        label: `Fin set: ${n} ${shape} fin${n === 1 ? "" : "s"}, ${mm(height)} mm tall, ${mm(part.length)} mm along the tube, ${mm(part.thickness)} mm thick${cant}`,
        about: `Keep the rocket pointing straight.${part.cant !== 0 ? " Turned a little at an angle (cant), they spin it as it flies." : ""}`,
        ...where,
      };
    }
    case "railbutton":
      return {
        label: `Rail button${part.instances.length === 1 ? "" : `s (${part.instances.length})`}: ${mm(part.outerDiameter)} mm across`,
        about: "Slide in the launch rail and guide the rocket until it leaves it.",
        from: from - part.outerDiameter / 2,
        to: Math.max(...part.instances.map((i) => i.x)) + part.outerDiameter / 2,
      };
    default:
      return { label: part.type, about: "", ...where };
  }
}

function mm(v: number): string {
  return String(Number(v.toFixed(1)));
}
