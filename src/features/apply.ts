// Cuts a part's details (from its comment, see parse.ts, and the automatic ones, see auto.ts) into
// one copy of its solid.

import type { Shape3D } from "replicad";
import type { Instance, Part, RocketModel } from "../ork/model.ts";
import { FeatureError, type Feature } from "./parse.ts";
import { endHoleTools, sideHoleTools } from "./holes.ts";
import { edgeTool, nutTrapTools, pocketTool, roundMouth } from "./cuts.ts";

export function cutFeatures(part: Part, model: RocketModel, inst: Instance, solid: Shape3D, warnings: string[]): Shape3D {
  for (const f of part.features) {
    let tools: Shape3D[];
    try {
      tools = toolsFor(part, model, inst, f, warnings);
    } catch (e) {
      if (!(e instanceof FeatureError)) throw e;
      // An automatic detail that doesn't fit is left out; one the user wrote is a problem to fix.
      if (f.auto) {
        warnings.push(`${part.name}: the automatic "${f.source}" was left out: ${e.message}.`);
        continue;
      }
      throw new FeatureError(`${part.name}, "${f.source}": ${e.message}`);
    }
    // One cut per tool. Fusing the tools first and cutting once can lose a piece: a ring of side
    // holes fused with a pocket they open into dropped one of the holes, and cutting overlapping
    // tools in one go removed too much. One at a time, every cut is a simple one.
    for (const t of tools) solid = solid.cut(t);
    if (f.kind === "pocket" && f.round > 0) solid = roundMouth(solid, part, model, inst, f, warnings);
  }
  return solid;
}

function toolsFor(part: Part, model: RocketModel, inst: Instance, f: Feature, warnings: string[]): Shape3D[] {
  switch (f.kind) {
    case "side-holes":
      return sideHoleTools(part, model, inst, f, warnings);
    case "end-holes":
      return endHoleTools(part, model, inst, f, warnings);
    case "pocket":
      return [pocketTool(part, model, inst, f)];
    case "nut-trap":
      return nutTrapTools(part, model, inst, f, warnings);
    case "chamfer":
    case "round":
      return [edgeTool(part, model, inst, f)];
    case "solid":
      // Built into the part's shape (isFilled); nothing to cut.
      if (part.kind !== "transition") throw new FeatureError(`only nose cones and transitions can be made solid this way, not a ${part.type}`);
      return [];
    case "screw-joint":
      // Built into the tube's shape (joint.ts), which also checked it; nothing to cut.
      if (part.features.filter((g) => g.kind === "screw-joint").length > 1) throw new FeatureError("a tube can have one screw joint");
      return [];
  }
}
