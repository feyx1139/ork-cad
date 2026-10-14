// Loads OpenCASCADE (the CAD kernel, compiled to WebAssembly) once for replicad.
// Node passes the .wasm bytes (see src/node/load.ts); a browser build would pass `locateFile`.

import init from "replicad-opencascadejs";
import { setOC } from "replicad";

let loading: Promise<void> | undefined;

export function initOpenCascade(options: Record<string, unknown> = {}): Promise<void> {
  // print/printErr silence OpenCASCADE's STEP-writer statistics on the console.
  loading ??= init({ print: () => {}, printErr: () => {}, ...options }).then((oc) => setOC(oc));
  return loading;
}
