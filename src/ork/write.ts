// Writes changes back into an .ork file: a component's comment, which is where the details (holes...)
// live, and simple fields such as a shoulder's length. Everything else stays as it was, including
// any other files in the archive (decal images).

import { strToU8, unzipSync, zipSync } from "fflate";
import { decodeOrkBytes, isZip, rocketEntry } from "./read.ts";

/** The browser's DOMParser/XMLSerializer, or @xmldom/xmldom's in Node. */
export interface XmlTools {
  parse(xml: string): Document;
  serialize(doc: Document): string;
}

/** Returns a new .ork with the comment of the component with this OpenRocket id replaced. */
export function setComment(bytes: Uint8Array, componentId: string, comment: string, xml: XmlTools): Uint8Array {
  return editComponent(bytes, componentId, xml, (doc, el) => {
    let c = child(el, "comment");
    if (!c) {
      // OpenRocket writes <comment> right after <id>.
      c = doc.createElement("comment");
      el.insertBefore(c, child(el, "id")?.nextSibling ?? el.firstChild);
    }
    c.textContent = comment;
  });
}

/**
 * Returns a new .ork with simple fields of a component set, as OpenRocket writes them: lengths in
 * metres, e.g. { aftshoulderlength: "0.0425", thickness: "filled" }.
 */
export function setFields(bytes: Uint8Array, componentId: string, fields: Record<string, string>, xml: XmlTools): Uint8Array {
  return editComponent(bytes, componentId, xml, (doc, el) => {
    for (const [tag, value] of Object.entries(fields)) {
      let f = child(el, tag);
      if (!f) {
        f = doc.createElement(tag);
        el.insertBefore(f, child(el, "subcomponents") ?? null);
      }
      f.textContent = value;
    }
  });
}

function editComponent(bytes: Uint8Array, componentId: string, xml: XmlTools, edit: (doc: Document, el: Element) => void): Uint8Array {
  const doc = xml.parse(decodeOrkBytes(bytes));
  const el = findComponent(doc.documentElement, componentId);
  if (!el) throw new Error(`The file has no component with id ${componentId}.`);
  edit(doc, el);
  let text = xml.serialize(doc);
  if (!text.startsWith("<?xml")) text = `<?xml version='1.0' encoding='utf-8'?>\n${text}`;
  const files = isZip(bytes) ? unzipSync(bytes) : {};
  files[rocketEntry(Object.keys(files)) ?? "rocket.ork"] = strToU8(text);
  return zipSync(files);
}

function findComponent(el: Element, id: string): Element | undefined {
  if (child(el, "id")?.textContent?.trim() === id) return el;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue;
    const found = findComponent(n as Element, id);
    if (found) return found;
  }
  return undefined;
}

function child(el: Element, tag: string): Element | undefined {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).tagName === tag) return n as Element;
  }
  return undefined;
}
