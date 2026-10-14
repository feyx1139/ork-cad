// Cuts a part's details (from its comment, see parse.ts) into one copy of its solid.

import type { Shape3D } from "replicad";
import type { Instance, Part, RocketModel } from "../ork/model.ts";
import { FeatureError, type Feature } from "./parse.ts";
import { endHoleTools, sideHoleTools } from "./holes.ts";
import { edgeTool, nutTrapTools, pocketTool } from "./cuts.ts";

export function cutFeatures(part: Part, model: RocketModel, inst: Instance, solid: Shape3D, warnings: string[]): Shape3D {
  let tool: Shape3D | undefined;
  for (const f of part.features) {
    let tools: Shape3D[];
    try {
      tools = toolsFor(part, model, inst, f, warnings);
    } catch (e) {
      if (e instanceof FeatureError) throw new FeatureError(`${part.name}, "${f.source}": ${e.message}`);
      throw e;
    }
    for (const t of tools) tool = tool ? tool.fuse(t) : t;
  }
  return tool ? solid.cut(tool) : solid;
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
  }
}
