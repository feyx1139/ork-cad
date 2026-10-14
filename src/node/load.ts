// Node-only helpers: read an .ork from disk, XML tools, and loading OpenCASCADE from node_modules.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { readOrk, type XmlDocument } from "../ork/read.ts";
import { buildModel, type RocketModel } from "../ork/model.ts";
import type { XmlTools } from "../ork/write.ts";
import { initOpenCascade } from "../geometry/oc.ts";
import { addAutoDetails } from "../features/auto.ts";

export const xmlTools: XmlTools = {
  parse: (xml) => new DOMParser().parseFromString(xml, "text/xml") as unknown as Document,
  serialize: (doc) => new XMLSerializer().serializeToString(doc as never),
};

/** auto: add the details ork-cad works out by itself (src/features/auto.ts), as the website and export do. */
export function modelFromBytes(bytes: Uint8Array, options: { auto?: boolean } = {}): RocketModel {
  const model = buildModel(readOrk(bytes, (xml) => xmlTools.parse(xml) as unknown as XmlDocument));
  if (options.auto) addAutoDetails(model);
  return model;
}

export async function loadOrkFile(path: string, options: { auto?: boolean } = {}): Promise<RocketModel> {
  return modelFromBytes(new Uint8Array(await readFile(path)), options);
}

export async function initOpenCascadeNode(): Promise<void> {
  const require = createRequire(import.meta.url);
  const wasmBinary = await readFile(require.resolve("replicad-opencascadejs/wasm"));
  await initOpenCascade({ wasmBinary });
}
