// Detail lines in plain words: "@side-holes count=4 diameter=0.9 at=247.5 angle=45" becomes
// "4 holes, 0.9 mm across, through the wall 247.5 mm from the top end ...", for the website and the
// report, so nobody has to know the line's settings to see what a detail does.

import type { Part } from "../ork/model.ts";
import type { Feature } from "./parse.ts";

export interface Description {
  /** A few words: "4 vent holes", "Altimeter pocket"... */
  title: string;
  /** What it is and where, in a sentence or two. */
  text: string;
}

/** The detail in words, on this part. */
export function describeFeature(f: Feature, part: Part): Description {
  switch (f.kind) {
    case "side-holes": {
      const where =
        f.from === "middle"
          ? `${mm(Math.abs(f.at))} mm ${f.at >= 0 ? "toward the tail" : "toward the nose"} from the middle of ${part.name}`
          : f.at < 0
            ? `${mm(-f.at)} mm into the ${f.from === "fore" ? "top" : "bottom"} shoulder`
            : `${mm(f.at)} mm from the ${endName(f.from)} of ${part.name}`;
      return {
        title: f.auto ? `${count(f.count, "altimeter vent")}` : `${count(f.count, "hole")} through the wall`,
        text:
          `${count(f.count, "hole")}, ${mm(f.diameter)} mm across, straight through the wall ${where}` +
          (f.count > 1 ? `, spaced evenly around it (${mm(360 / f.count)}° apart)` : "") +
          `, ${aroundFrom(f.angle, f.count > 1 ? "the first" : "it")}.`,
      };
    }
    case "end-holes": {
      const cap = f.end === "fore" ? "top cap" : f.end === "aft" ? "bottom cap" : "cap";
      return {
        title: `${count(f.count, "hole")} through the ${cap}`,
        text:
          `${count(f.count, "hole")}, ${mm(f.diameter)} mm across, through the ${f.end ? cap : "cap or ring"}, ` +
          `along the rocket's axis` +
          (f.radius > 0 ? `, ${mm(f.radius)} mm out from the middle` : ", in the middle") +
          (f.count > 1 ? `, spaced evenly around (${mm(360 / f.count)}° apart), ${aroundFrom(f.angle, "the first")}` : "") +
          ".",
      };
    }
    case "pocket": {
      const s = f.shape;
      const shape =
        s.kind === "rect"
          ? `${mm(s.width)} × ${mm(s.height)} mm rectangular${s.corner > 0 ? ` (corners rounded ${mm(s.corner)} mm)` : ""}`
          : `${mm(s.diameter)} mm round`;
      return {
        title: f.auto ? "Altimeter pocket" : "Pocket",
        text:
          `A ${shape} pocket cut ${mm(f.depth)} mm deep into ${part.name} along its axis, opening at the ${endName(f.end)}` +
          (f.round > 0 ? `, its opening rounded off (${mm(f.round)} mm) to guide what goes in` : "") +
          (s.kind === "rect" && f.angle !== 0 ? `, turned ${deg(f.angle)}°` : "") +
          ".",
      };
    }
    case "nut-trap":
      return {
        title: f.auto ? `${f.size} nut for the eyebolt` : `${f.size} captive nut`,
        text:
          `A pocket that holds ${/^M/i.test(f.size) ? "an" : "a"} ${f.size} hex nut ${mm(f.depth)} mm in from the ${endName(f.end)}, with a ${mm(f.hole)} mm hole ` +
          `for the screw (an eyebolt, say) along the axis. The nut slides in through a slot in the side, ` +
          `${aroundFrom(f.angle, "facing")}, and then can't turn or fall out.`,
      };
    case "chamfer":
      return {
        title: `Bevelled ${endName(f.end)}`,
        text:
          `The outside edge at the ${endName(f.end)} is bevelled over ${mm(f.length)} mm, at ${deg(f.angle)}° to the rocket's axis` +
          (f.round > 0 ? `, blended in with a ${mm(f.round)} mm round` : "") +
          `, so it slides into its tube easily.`,
      };
    case "round":
      return {
        title: `Rounded ${endName(f.end)}`,
        text: `The outside edge at the ${endName(f.end)} is rounded off with a ${mm(f.radius)} mm radius.`,
      };
    case "solid":
      return {
        title: "Printed solid",
        text: `${part.name} is built solid (filled with plastic), although it's hollow in OpenRocket, so pockets and nuts can go in it.`,
      };
    case "screw-joint":
      return {
        title: "Screw joint",
        text:
          `${part.name} is printed in two pieces that screw together ${mm(f.at)} mm from its ${endName(f.from)}: a threaded plug on ` +
          `the bottom piece screws into the top piece (${mm(f.pitch)} mm per turn, ${mm(f.length)} mm of thread)` +
          (f.detent ? ", and clicks into place when it's screwed home" : "") +
          `. The outside stays one smooth tube.`,
      };
    case "one-piece":
      return {
        title: "Printed with the tube",
        text: `The fins are printed as part of the body tube they're on, in the tube's file: nothing to glue or line up.`,
      };
  }
}

/** The fore end is the top (toward the nose), as the rocket stands on the pad. */
export function endName(end: "fore" | "aft"): string {
  return end === "fore" ? "top end" : "bottom end";
}

/** Where round the rocket something points: angle 0 lines up with the first fin. */
function aroundFrom(angle: number, what: string): string {
  const d = ((((angle * 180) / Math.PI) % 360) + 360) % 360;
  if (Math.abs(d) < 1e-9) return `${what} in line with the first fin`;
  return `${what} ${mm(d)}° round from the first fin`;
}

function count(n: number, thing: string): string {
  return `${n} ${thing}${n === 1 ? "" : "s"}`;
}

function mm(v: number): string {
  return String(Number(v.toFixed(2)));
}

function deg(radians: number): string {
  return mm((radians * 180) / Math.PI);
}
