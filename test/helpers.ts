// Shared test helpers: fixture paths, OpenRocket reference data and OBJ parsing.
//
// test/fixtures/ holds example rockets that come with OpenRocket. Designs that shouldn't be
// published can go in test/private/fixtures/ (not in git): every rocket test runs on them too.

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));
const PRIVATE_DIR = fileURLToPath(new URL("./private/fixtures/", import.meta.url));

const designs = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".ork")).map((f) => f.slice(0, -4)) : [];

export const ROCKETS = [...designs(PUBLIC_DIR), ...designs(PRIVATE_DIR)];

export function fixture(name: string): string {
  return existsSync(PUBLIC_DIR + name) || !existsSync(PRIVATE_DIR + name) ? PUBLIC_DIR + name : PRIVATE_DIR + name;
}

/** What OpenRocket itself computed for each component (tools/openrocket-ref/RefExport.java). */
export interface Reference {
  rocket: string;
  rocketLength: number;
  components: {
    name: string;
    type: string;
    id: string;
    comment?: string;
    objGroup: string | null;
    length: number;
    instanceCount: number;
    locations: [number, number, number][];
    componentMass: number;
    componentVolume: number | null;
    materialDensity?: number;
    materialType?: string;
  }[];
}

export async function readReference(rocket: string): Promise<Reference> {
  return JSON.parse(await readFile(fixture(`${rocket}.openrocket.json`), "utf8")) as Reference;
}

export interface Obj {
  vertices: [number, number, number][];
  /** Group number (the "17" in "g 17_Rail buttons") to the vertex indices its faces use. */
  groups: Map<number, number[]>;
}

export async function readObj(rocket: string): Promise<Obj> {
  const text = await readFile(fixture(`${rocket}.openrocket.obj`), "utf8");
  const vertices: [number, number, number][] = [];
  const groups = new Map<number, Set<number>>();
  let current: Set<number> | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("v ")) {
      const [, x, y, z] = line.trim().split(/\s+/);
      vertices.push([Number(x), Number(y), Number(z)]);
    } else if (line.startsWith("g ")) {
      const n = Number.parseInt(line.slice(2), 10);
      current = groups.get(n) ?? new Set();
      groups.set(n, current);
    } else if (line.startsWith("f ") && current) {
      for (const ref of line.trim().split(/\s+/).slice(1)) current.add(Number.parseInt(ref, 10) - 1);
    }
  }
  return { vertices, groups: new Map([...groups].map(([k, v]) => [k, [...v]])) };
}
