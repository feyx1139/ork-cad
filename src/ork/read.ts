// Reads an OpenRocket .ork file into a plain tree of components.
//
// An .ork file is normally a zip archive holding one XML file (rocket.ork). Older files may be
// gzipped XML or plain XML. Nothing here is interpreted yet: every component keeps all of its
// fields as text so later stages can read whatever they need.

import { gunzipSync, unzipSync } from "fflate";

/** The few DOM features the reader needs; satisfied by the browser's DOMParser and by @xmldom/xmldom. */
export interface XmlNode {
  nodeType: number;
}
export interface XmlElement extends XmlNode {
  tagName: string;
  childNodes: ArrayLike<XmlNode>;
  textContent: string | null;
  attributes: ArrayLike<{ name: string; value: string }>;
}
export interface XmlDocument {
  documentElement: XmlElement | null;
}
export type XmlParser = (xml: string) => XmlDocument;

/** One simple field of a component, e.g. `<aftradius>auto 0.0281559</aftradius>`. */
export interface OrkField {
  text: string;
  attrs: Record<string, string>;
}

/** One component element (`<nosecone>`, `<bodytube>`, ...) with its fields and child components. */
export interface OrkNode {
  tag: string;
  /** First occurrence of each simple child element, by tag name. */
  fields: Map<string, OrkField>;
  /** Child elements that have their own child elements (e.g. `<motormount>`), kept as-is. */
  complex: Map<string, XmlElement>;
  /** Components inside `<subcomponents>`, in file order. */
  children: OrkNode[];
  element: XmlElement;
}

export interface OrkFile {
  /** File format version, e.g. "1.10". */
  formatVersion: string;
  /** Program that wrote the file, e.g. "OpenRocket 24.12". */
  creator: string;
  /** The `<rocket>` component. */
  rocket: OrkNode;
}

const ELEMENT_NODE = 1;

export function readOrk(bytes: Uint8Array, parseXml: XmlParser): OrkFile {
  const doc = parseXml(decodeOrkBytes(bytes));
  const root = doc.documentElement;
  if (!root || root.tagName !== "openrocket") {
    throw new Error("Not an OpenRocket file: the XML root element isn't <openrocket>.");
  }
  const attrs = attributesOf(root);
  const rocketEl = childElements(root).find((el) => el.tagName === "rocket");
  if (!rocketEl) {
    throw new Error("The file has no <rocket> element.");
  }
  return {
    formatVersion: attrs.version ?? "",
    creator: attrs.creator ?? "",
    rocket: readNode(rocketEl),
  };
}

/** Unzips or gunzips the file if needed and returns the XML text. */
export function decodeOrkBytes(bytes: Uint8Array): string {
  const decoder = new TextDecoder("utf-8");
  if (isZip(bytes)) {
    const entries = unzipSync(bytes);
    const names = Object.keys(entries);
    const name = rocketEntry(names);
    if (!name) {
      throw new Error(`The .ork archive has no rocket XML inside (found: ${names.join(", ") || "nothing"}).`);
    }
    return decoder.decode(entries[name]);
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return decoder.decode(gunzipSync(bytes));
  }
  return decoder.decode(bytes);
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/** The archive entry holding the rocket XML. */
export function rocketEntry(names: string[]): string | undefined {
  return (
    names.find((n) => n === "rocket.ork") ??
    names.find((n) => /\.(ork|xml)$/i.test(n) && !n.includes("/")) ??
    names.find((n) => /\.(ork|xml)$/i.test(n))
  );
}

function readNode(el: XmlElement): OrkNode {
  const node: OrkNode = { tag: el.tagName, fields: new Map(), complex: new Map(), children: [], element: el };
  for (const child of childElements(el)) {
    if (child.tagName === "subcomponents") {
      node.children = childElements(child).map(readNode);
    } else if (childElements(child).length > 0) {
      if (!node.complex.has(child.tagName)) node.complex.set(child.tagName, child);
    } else if (!node.fields.has(child.tagName)) {
      node.fields.set(child.tagName, { text: (child.textContent ?? "").trim(), attrs: attributesOf(child) });
    }
  }
  return node;
}

export function childElements(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i];
    if (n.nodeType === ELEMENT_NODE) out.push(n as XmlElement);
  }
  return out;
}

export function attributesOf(el: XmlElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    out[a.name] = a.value;
  }
  return out;
}
