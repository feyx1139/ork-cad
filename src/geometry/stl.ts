// Triangle meshes: reading STL files (binary or text), and the facts about a mesh that the checks
// need: whether it's closed, its volume and its area.

export interface TriangleMesh {
  /** x, y, z of each vertex, mm. Vertices that triangles share appear once. */
  vertices: Float64Array;
  /** Three vertex indices per triangle, counter-clockwise seen from outside. */
  triangles: Uint32Array;
}

/** Reads a binary or text STL file. Corners at exactly the same point become one vertex. */
export function readSTL(bytes: Uint8Array): TriangleMesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.byteLength >= 84 ? view.getUint32(80, true) : -1;
  const corners: number[] = [];
  if (count >= 0 && 84 + 50 * count === bytes.byteLength) {
    for (let t = 0; t < count; t++) {
      const at = 84 + 50 * t + 12; // after the normal
      for (let k = 0; k < 9; k++) corners.push(view.getFloat32(at + 4 * k, true));
    }
  } else {
    const text = new TextDecoder().decode(bytes);
    if (!/^\s*solid/i.test(text)) throw new Error("This isn't an STL file.");
    const number = String.raw`([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)`;
    const vertex = new RegExp(String.raw`vertex\s+${number}\s+${number}\s+${number}`, "gi");
    for (const m of text.matchAll(vertex)) corners.push(Number(m[1]), Number(m[2]), Number(m[3]));
    if (corners.length % 9 !== 0) throw new Error("The STL file has a triangle without three corners.");
  }
  if (!corners.length) throw new Error("The STL file has no triangles.");
  return indexMesh(corners);
}

/** Joins corners (x, y, z of three corners per triangle) that are at exactly the same point. */
export function indexMesh(corners: ArrayLike<number>, triangles?: ArrayLike<number>): TriangleMesh {
  const ids = new Map<string, number>();
  const vertices: number[] = [];
  const order = triangles ?? Array.from({ length: corners.length / 3 }, (_, i) => i);
  const out = new Uint32Array(order.length);
  for (let i = 0; i < order.length; i++) {
    const v = order[i];
    const x = corners[3 * v];
    const y = corners[3 * v + 1];
    const z = corners[3 * v + 2];
    const key = `${x},${y},${z}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = vertices.length / 3;
      ids.set(key, id);
      vertices.push(x, y, z);
    }
    out[i] = id;
  }
  return { vertices: Float64Array.from(vertices), triangles: out };
}

/**
 * A mesh as an STL file holds it: corners rounded to 32-bit numbers, corners that land on the same
 * point joined, and triangles that collapse to a line left out. OpenCASCADE puts such a collapsed
 * triangle at the tip of a nose cone, which leaves the surface open there.
 */
export function stlMesh(corners: ArrayLike<number>, triangles: ArrayLike<number>): TriangleMesh {
  const m = indexMesh(Float32Array.from(corners), triangles);
  const kept: number[] = [];
  const t = m.triangles;
  for (let i = 0; i < t.length; i += 3) {
    if (t[i] !== t[i + 1] && t[i + 1] !== t[i + 2] && t[i] !== t[i + 2]) kept.push(t[i], t[i + 1], t[i + 2]);
  }
  return { vertices: m.vertices, triangles: Uint32Array.from(kept) };
}

/** A binary STL file of a mesh. */
export function writeSTL(m: TriangleMesh, title: string): Uint8Array {
  const n = m.triangles.length / 3;
  const out = new Uint8Array(84 + 50 * n);
  const view = new DataView(out.buffer);
  // Some programs read a header starting with "solid" as a text STL, so it starts otherwise.
  out.set(new TextEncoder().encode(`ork-cad: ${title}`).slice(0, 80));
  view.setUint32(80, n, true);
  let at = 84;
  forTriangles(m, (a, b, c) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const normal = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const length = Math.hypot(...normal) || 1;
    for (const x of [...normal.map((x) => x / length), ...a, ...b, ...c]) {
      view.setFloat32(at, x, true);
      at += 4;
    }
    at += 2; // attribute byte count: 0
  });
  return out;
}

/** Volume inside a closed mesh, mm³ (from the divergence theorem; negative if it faces inward). */
export function meshVolume(m: TriangleMesh): number {
  let six = 0;
  forTriangles(m, (a, b, c) => {
    six += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  });
  return six / 6;
}

export function meshArea(m: TriangleMesh): number {
  let area = 0;
  forTriangles(m, (a, b, c) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    area += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
  });
  return area;
}

/**
 * Edges that don't join exactly two triangles running opposite ways along them. A closed surface
 * with consistent sides, which is what a slicer needs, has none.
 */
export function badEdges(m: TriangleMesh): number {
  const uses = new Map<string, number>();
  const t = m.triangles;
  for (let i = 0; i < t.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = t[i + k];
      const b = t[i + ((k + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      uses.set(key, (uses.get(key) ?? 0) + (a < b ? 1 : 1000));
    }
  }
  let bad = 0;
  for (const n of uses.values()) if (n !== 1001) bad++;
  return bad;
}

function forTriangles(m: TriangleMesh, f: (a: number[], b: number[], c: number[]) => void): void {
  const v = m.vertices;
  const t = m.triangles;
  const at = (i: number) => [v[3 * i], v[3 * i + 1], v[3 * i + 2]];
  for (let i = 0; i < t.length; i += 3) f(at(t[i]), at(t[i + 1]), at(t[i + 2]));
}
