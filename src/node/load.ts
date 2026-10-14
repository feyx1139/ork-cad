// Node-only helpers: read an .ork from disk, XML tools, and loading OpenCASCADE from node_modules.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { readOrk, type XmlDocument } from "../ork/read.ts";
import { buildModel, type RocketModel } from "../ork/model.ts";
import type { XmlTools } from "../ork/write.ts";
import { initOpenCascade } from "../geometry/oc.ts";

export const xmlTools: XmlTools = {
  parse: (xml) => new DOMParser().parseFromString(xml, "text/xml") as unknown as Document,
  serialize: (doc) => new XMLSerializer().serializeToString(doc as never),
};

export function modelFromBytes(bytes: Uint8Array): RocketModel {
  return buildModel(readOrk(bytes, (xml) => xmlTools.parse(xml) as unknown as XmlDocument));
}

export async function loadOrkFile(path: string): Promise<RocketModel> {
  return modelFromBytes(new Uint8Array(await readFile(path)));
}

export async function initOpenCascadeNode(): Promise<void> {
  const require = createRequire(import.meta.url);
  const wasmBinary = await readFile(require.resolve("replicad-opencascadejs/wasm"));
  await initOpenCascade({ wasmBinary });
}
