// How far points are from a triangle mesh, quickly: the triangles are sorted into a grid of cubes,
// so each point only looks at the triangles near it. Used to compare two parts surface to surface.

import type { TriangleMesh } from "../geometry/stl.ts";

/** Cubes per axis the grid can address; with 0.5 mm cubes that's 65 m each way. */
const SIDE = 1 << 17;
const key = (a: number, b: number, c: number) => ((a + SIDE / 2) * SIDE + (b + SIDE / 2)) * SIDE + (c + SIDE / 2);

export class MeshDistance {
  private cells = new Map<number, number[]>();
  private v: Float64Array;
  private t: Uint32Array;
  private seen: Int32Array;
  private query = 0;
  private cell: number;

  /** `cell` (mm) should be at least the largest distance that will be asked about. */
  constructor(mesh: TriangleMesh, cell: number) {
    this.cell = cell;
    this.v = mesh.vertices;
    this.t = mesh.triangles;
    this.seen = new Int32Array(this.t.length / 3);
    for (let i = 0; i < this.t.length; i += 3) {
      let [x0, y0, z0, x1, y1, z1] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let k = 0; k < 3; k++) {
        const j = 3 * this.t[i + k];
        x0 = Math.min(x0, this.v[j]);
        x1 = Math.max(x1, this.v[j]);
        y0 = Math.min(y0, this.v[j + 1]);
        y1 = Math.max(y1, this.v[j + 1]);
        z0 = Math.min(z0, this.v[j + 2]);
        z1 = Math.max(z1, this.v[j + 2]);
      }
      for (let a = Math.floor(x0 / cell); a <= Math.floor(x1 / cell); a++) {
        for (let b = Math.floor(y0 / cell); b <= Math.floor(y1 / cell); b++) {
          for (let c = Math.floor(z0 / cell); c <= Math.floor(z1 / cell); c++) {
            const id = key(a, b, c);
            const list = this.cells.get(id);
            if (list) list.push(i / 3);
            else this.cells.set(id, [i / 3]);
          }
        }
      }
    }
  }

  /**
   * Distance from a point to the nearest triangle, if it's within `reach` cubes of the point's own;
   * Infinity if there is no triangle that close.
   */
  distance(x: number, y: number, z: number, reach = 1): number {
    const a = Math.floor(x / this.cell);
    const b = Math.floor(y / this.cell);
    const c = Math.floor(z / this.cell);
    const stamp = ++this.query;
    // The point's own cube first: if a triangle there is nearer than the cube's walls, no other
    // cube can have a nearer one.
    let best = this.scan(key(a, b, c), x, y, z, stamp, Infinity);
    const h = this.cell;
    if (best <= Math.min(x - a * h, (a + 1) * h - x, y - b * h, (b + 1) * h - y, z - c * h, (c + 1) * h - z)) return best;
    for (let da = -reach; da <= reach; da++) {
      for (let db = -reach; db <= reach; db++) {
        for (let dc = -reach; dc <= reach; dc++) {
          if (da || db || dc) best = this.scan(key(a + da, b + db, c + dc), x, y, z, stamp, best);
        }
      }
    }
    return best <= reach * this.cell ? best : Infinity;
  }

  private scan(cell: number, x: number, y: number, z: number, stamp: number, best: number): number {
    const list = this.cells.get(cell);
    if (!list) return best;
    for (const i of list) {
      if (this.seen[i] === stamp) continue;
      this.seen[i] = stamp;
      const d = this.toTriangle(x, y, z, 3 * i);
      if (d < best) best = d;
    }
    return best;
  }

  /** Distance from a point to the triangle starting at t[i] (closest point, Ericson 5.1.5). */
  private toTriangle(px: number, py: number, pz: number, i: number): number {
    const v = this.v;
    const ia = 3 * this.t[i];
    const ib = 3 * this.t[i + 1];
    const ic = 3 * this.t[i + 2];
    const ax = v[ia];
    const ay = v[ia + 1];
    const az = v[ia + 2];
    const abx = v[ib] - ax;
    const aby = v[ib + 1] - ay;
    const abz = v[ib + 2] - az;
    const acx = v[ic] - ax;
    const acy = v[ic + 1] - ay;
    const acz = v[ic + 2] - az;
    const apx = px - ax;
    const apy = py - ay;
    const apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    let u: number;
    let w: number;
    if (d1 <= 0 && d2 <= 0) {
      [u, w] = [0, 0];
    } else {
      const d3 = d1 - (abx * abx + aby * aby + abz * abz);
      const d4 = d2 - (acx * abx + acy * aby + acz * abz);
      if (d3 >= 0 && d4 <= d3) {
        [u, w] = [1, 0];
      } else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) {
          [u, w] = [d1 / (d1 - d3), 0];
        } else {
          const d5 = d1 - (abx * acx + aby * acy + abz * acz);
          const d6 = d2 - (acx * acx + acy * acy + acz * acz);
          if (d6 >= 0 && d5 <= d6) {
            [u, w] = [0, 1];
          } else {
            const vb = d5 * d2 - d1 * d6;
            if (vb <= 0 && d2 >= 0 && d6 <= 0) {
              [u, w] = [0, d2 / (d2 - d6)];
            } else {
              const va = d3 * d6 - d5 * d4;
              if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
                const f = (d4 - d3) / (d4 - d3 + (d5 - d6));
                [u, w] = [1 - f, f];
              } else {
                const denom = 1 / (va + vb + vc);
                [u, w] = [vb * denom, vc * denom];
              }
            }
          }
        }
      }
    }
    return Math.hypot(apx - u * abx - w * acx, apy - u * aby - w * acy, apz - u * abz - w * acz);
  }
}

/**
 * Points spread over a mesh's surface, no further than about `spacing` apart, including every
 * corner. Long thin triangles (the walls of a drilled hole, say) get points all along them.
 */
export function surfacePoints(mesh: TriangleMesh, spacing: number): Float64Array {
  const v = mesh.vertices;
  const t = mesh.triangles;
  const out: number[] = Array.from(v);
  for (let i = 0; i < t.length; i += 3) {
    const a = 3 * t[i];
    const b = 3 * t[i + 1];
    const c = 3 * t[i + 2];
    const ab = [v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]];
    const ac = [v[c] - v[a], v[c + 1] - v[a + 1], v[c + 2] - v[a + 2]];
    const nu = Math.ceil(Math.hypot(ab[0], ab[1], ab[2]) / spacing);
    const nw = Math.ceil(Math.hypot(ac[0], ac[1], ac[2]) / spacing);
    for (let iu = 0; iu <= nu; iu++) {
      for (let iw = 0; iw <= nw; iw++) {
        const u = iu / nu;
        const w = iw / nw;
        // Skip the corners (already in) and points past the third side.
        if (u + w > 1 + 1e-12 || (iu === 0 && iw === 0) || (iu === nu && iw === 0) || (iu === 0 && iw === nw)) continue;
        out.push(v[a] + u * ab[0] + w * ac[0], v[a + 1] + u * ab[1] + w * ac[1], v[a + 2] + u * ab[2] + w * ac[2]);
      }
    }
  }
  return Float64Array.from(out);
}
