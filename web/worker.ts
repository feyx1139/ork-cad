// The CAD worker: loads OpenCASCADE (about 23 MB of WebAssembly) once, then opens designs, builds
// parts and makes downloads, so the page stays responsive. Requests run one at a time.

import wasmUrl from "replicad-opencascadejs/wasm?url";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { initOpenCascade } from "../src/geometry/oc.ts";
import type { XmlTools } from "../src/ork/write.ts";
import { Session, type PartView } from "./session.ts";
import type { Message, Request } from "./protocol.ts";

const xml: XmlTools = {
  parse: (text) => new DOMParser().parseFromString(text, "text/xml") as unknown as Document,
  serialize: (doc) => new XMLSerializer().serializeToString(doc as never),
};

const scope = self as unknown as {
  postMessage(message: Message, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<Request>) => void) | null;
};
const post = (message: Message, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

let engine: Promise<void> | undefined;
let session: Session | undefined;
let queue = Promise.resolve();

scope.onmessage = (e) => {
  queue = queue.then(() => handle(e.data));
};

async function handle(req: Request): Promise<void> {
  try {
    if (!engine) {
      post({ type: "progress", text: "Loading the CAD engine (only the first time)…" });
      engine = initOpenCascade({ locateFile: () => wasmUrl });
    }
    await engine;
    switch (req.type) {
      case "open": {
        post({ type: "progress", text: `Reading ${req.fileName}…` });
        session = Session.open(new Uint8Array(req.bytes), req.fileName, xml);
        post({ type: "rocket", rocket: session.rocket, partCount: session.parts.length });
        session.buildAll((part, done, total) => {
          post({ type: "progress", text: `Building ${part.name} (${done} of ${total})…` });
          sendPart(part, done, total);
        });
        post({ type: "spaces", spaces: session.spaces() });
        break;
      }
      case "setDetails": {
        // The edited part, and any whose automatic details changed with it.
        for (const part of need(session).setDetails(req.key, req.details)) sendPart(part);
        post({ type: "spaces", spaces: need(session).spaces() });
        break;
      }
      case "file": {
        const file = await need(session).partFile(req.key, req.format);
        return sendFile(req.id, file.name, file.bytes);
      }
      case "zip": {
        post({ type: "progress", text: "Making STL files for every part…" });
        const file = await need(session).zip();
        return sendFile(req.id, file.name, file.bytes);
      }
      case "rocketStep": {
        post({ type: "progress", text: "Making the STEP file for Onshape…" });
        const file = need(session).rocketStep();
        return sendFile(req.id, file.name, file.bytes);
      }
      case "save": {
        const file = need(session).saveOrk();
        return sendFile(req.id, file.name, file.bytes);
      }
      case "compare": {
        const match = await need(session).compare(req.key, new Uint8Array(req.bytes), req.fileName, {
          flip: req.flip,
          progress: (text) => post({ type: "progress", text }),
        });
        post({ id: req.id, type: "match", match });
        return;
      }
      case "detailShape": {
        post({ type: "progress", text: "Working out what the detail does…" });
        const shape = need(session).detailShape(req.key, req.index);
        const buffers = [shape.removed, shape.added].flatMap((m) => (m ? [m.vertices.buffer, m.normals.buffer, m.triangles.buffer, m.edges.buffer] : []));
        post({ id: req.id, type: "detailShape", shape }, buffers);
        return;
      }
      case "applyMatch": {
        const s = need(session);
        s.applyMatch(req.key);
        post({ type: "rocket", rocket: s.rocket, partCount: s.parts.length });
        s.buildAll((part, done, total) => {
          post({ type: "progress", text: `Building ${part.name} (${done} of ${total})…` });
          sendPart(part, done, total);
        });
        post({ type: "spaces", spaces: s.spaces() });
        break;
      }
    }
    post({ id: req.id, type: "done" });
  } catch (err) {
    post({ id: req.id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

function need(s: Session | undefined): Session {
  if (!s) throw new Error("Open a design first.");
  return s;
}

function sendPart(part: PartView, done?: number, total?: number): void {
  const m = part.mesh;
  post({ type: "part", part, done, total }, m ? [m.vertices.buffer, m.normals.buffer, m.triangles.buffer, m.edges.buffer] : []);
}

function sendFile(id: number, name: string, bytes: Uint8Array): void {
  const copy = bytes.slice().buffer; // a standalone buffer that can be handed over
  post({ id, type: "file", name, bytes: copy }, [copy]);
}
