// A real part to compare with the design, from a STEP or STL file (e.g. exported from Onshape):
// its triangles, the axis it's turned around, and its outline along that axis.
//
// Nose cones and transitions are solids of revolution, so their outside is a profile turned around
// an axis. The axis is found from the part's mass (its symmetry axis is the principal axis with the
// odd moment of inertia), then made exact from the rings of triangle corners that a meshed surface
// of revolution has: each ring's centre is on the axis and its plane is square to it.

import { importSTEP, type Shape3D } from "replicad";
import { solidVolume } from "../geometry/measure.ts";
import { indexMesh, meshVolume, readSTL, type TriangleMesh } from "../geometry/stl.ts";

export type V3 = [number, number, number];

export interface CadPart {
  mesh: TriangleMesh;
  /** mm³: exact for a STEP file, from the triangles for an STL. */
  volume: number;
  format: "step" | "stl";
  notes: string[];
}

/** A STEP part is cut into triangles this fine: corners on the surface, sides within 0.01 mm. */
const CAD_MESH = { tolerance: 0.01, angularTolerance: 0.1 };

export async function readCad(bytes: Uint8Array, fileName: string): Promise<CadPart> {
  const notes: string[] = [];
  const head = new TextDecoder().decode(bytes.slice(0, 32));
  if (/\.(step|stp)$/i.test(fileName) || head.startsWith("ISO-10303-21")) {
    const shape = (await importSTEP(new Blob([bytes.slice()]))) as Shape3D;
    const solids = shape.solids;
    if (!solids.length) throw new Error(`${fileName} has no solid in it.`);
    const sized = solids.map((s) => ({ s, v: solidVolume(s) })).sort((a, b) => b.v - a.v);
    if (sized.length > 1) notes.push(`${fileName} has ${sized.length} solids; comparing the biggest.`);
    const m = sized[0].s.mesh(CAD_MESH);
    return { mesh: indexMesh(m.vertices, m.triangles), volume: sized[0].v, format: "step", notes };
  }
  const mesh = readSTL(bytes);
  const volume = meshVolume(mesh);
  if (volume < 0) {
    // Triangles facing inward: turn them round.
    const t = mesh.triangles;
    for (let i = 0; i < t.length; i += 3) [t[i + 1], t[i + 2]] = [t[i + 2], t[i + 1]];
  }
  return { mesh, volume: Math.abs(volume), format: "stl", notes };
}

/** Multiplies every corner by `factor` (e.g. 25.4 for a file in inches). */
export function scaleMesh(m: TriangleMesh, factor: number): TriangleMesh {
  return { vertices: m.vertices.map((v) => v * factor), triangles: m.triangles };
}

export interface Axis {
  point: V3;
  /** Unit vector. */
  dir: V3;
}

// ---------------------------------------------------------------------------------------------
// Small vector and matrix helpers

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: V3): V3 => mul(a, 1 / norm(a));

/** Eigenvalues and unit eigenvectors of a symmetric 3x3 matrix (Jacobi rotations). */
export function eigenSymmetric(m: number[][]): { values: number[]; vectors: V3[] } {
  const a = m.map((row) => row.slice());
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 100; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    const diag = a[0][0] ** 2 + a[1][1] ** 2 + a[2][2] ** 2;
    if (off <= 1e-30 * diag || off === 0) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (a[p][q] === 0) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      // a <- J^T a J and v <- v J, with J the rotation in the (p, q) plane.
      for (let k = 0; k < 3; k++) {
        const kp = a[k][p];
        const kq = a[k][q];
        a[k][p] = c * kp - s * kq;
        a[k][q] = s * kp + c * kq;
      }
      for (let k = 0; k < 3; k++) {
        const pk = a[p][k];
        const qk = a[q][k];
        a[p][k] = c * pk - s * qk;
        a[q][k] = s * pk + c * qk;
      }
      for (let k = 0; k < 3; k++) {
        const kp = v[k][p];
        const kq = v[k][q];
        v[k][p] = c * kp - s * kq;
        v[k][q] = s * kp + c * kq;
      }
    }
  }
  return {
    values: [a[0][0], a[1][1], a[2][2]],
    vectors: [0, 1, 2].map((j) => [v[0][j], v[1][j], v[2][j]] as V3),
  };
}

// ---------------------------------------------------------------------------------------------
// The axis

/** Volume, centroid and covariance (second moments about the centroid, per volume) of a closed mesh. */
export function massProperties(m: TriangleMesh): { volume: number; centroid: V3; cov: number[][] } {
  const v = m.vertices;
  const t = m.triangles;
  // Measure from the middle of the bounding box, for accuracy.
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], v[i + k]);
      hi[k] = Math.max(hi[k], v[i + k]);
    }
  }
  const o = mul(add(lo, hi), 0.5);
  let six = 0;
  const first: V3 = [0, 0, 0];
  const second = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const at = (i: number): V3 => [v[3 * i] - o[0], v[3 * i + 1] - o[1], v[3 * i + 2] - o[2]];
  for (let i = 0; i < t.length; i += 3) {
    const a = at(t[i]);
    const b = at(t[i + 1]);
    const c = at(t[i + 2]);
    // The tetrahedron from the origin to the triangle: det = 6 x its signed volume.
    const det = dot(a, cross(b, c));
    six += det;
    const sum = add(add(a, b), c);
    for (let k = 0; k < 3; k++) first[k] += (det / 24) * sum[k];
    for (let p = 0; p < 3; p++) {
      for (let q = 0; q < 3; q++) second[p][q] += (det / 120) * (a[p] * a[q] + b[p] * b[q] + c[p] * c[q] + sum[p] * sum[q]);
    }
  }
  const volume = six / 6;
  const c = mul(first, 1 / volume);
  const cov = second.map((row, p) => row.map((x, q) => x / volume - c[p] * c[q]));
  return { volume, centroid: add(o, c), cov };
}

/** The principal axis whose moment differs most from the other two: a solid of revolution's axis. */
export function inertiaAxis(m: TriangleMesh): Axis {
  const { centroid, cov } = massProperties(m);
  const { values, vectors } = eigenSymmetric(cov);
  let best = 0;
  let bestGap = -1;
  for (let k = 0; k < 3; k++) {
    const gap = Math.min(...[0, 1, 2].filter((j) => j !== k).map((j) => Math.abs(values[k] - values[j])));
    if (gap > bestGap) [best, bestGap] = [k, gap];
  }
  return { point: centroid, dir: unit(vectors[best]) };
}

/** Each corner's position along the axis (s), distance from it (r) and the two across it. */
export function cylindrical(m: TriangleMesh, axis: Axis, e1: V3): { s: Float64Array; r: Float64Array; x: Float64Array; y: Float64Array } {
  const n = m.vertices.length / 3;
  const s = new Float64Array(n);
  const r = new Float64Array(n);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const e2 = cross(e1, axis.dir);
  const [px, py, pz] = axis.point;
  const [ux, uy, uz] = axis.dir;
  for (let i = 0; i < n; i++) {
    const dx = m.vertices[3 * i] - px;
    const dy = m.vertices[3 * i + 1] - py;
    const dz = m.vertices[3 * i + 2] - pz;
    const along = dx * ux + dy * uy + dz * uz;
    const w: V3 = [dx - along * ux, dy - along * uy, dz - along * uz];
    s[i] = along;
    x[i] = dot(w, e1);
    y[i] = dot(w, e2);
    r[i] = Math.hypot(x[i], y[i]);
  }
  return { s, r, x, y };
}

/** A direction square to the axis to measure angles from: the file's X axis, or Y if X runs along it. */
export function angleReference(axis: Axis): V3 {
  const x: V3 = Math.abs(axis.dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return unit(sub(x, mul(axis.dir, dot(x, axis.dir))));
}

interface Ring {
  center: V3;
  normal: V3;
  radius: number;
  count: number;
}

/** A circle through points in 3D: their plane (by principal components) and a least-squares circle in it. */
function fitCircle(points: V3[]): Ring & { residual: number } {
  const c = mul(points.reduce(add, [0, 0, 0] as V3), 1 / points.length);
  const cov = [0, 1, 2].map((p) => [0, 1, 2].map((q) => points.reduce((sum, pt) => sum + (pt[p] - c[p]) * (pt[q] - c[q]), 0)));
  const { values, vectors } = eigenSymmetric(cov);
  const k = values.indexOf(Math.min(...values));
  const normal = unit(vectors[k]);
  const e1 = unit(vectors[(k + 1) % 3]);
  const e2 = cross(normal, e1);
  // Kasa fit: x² + y² + Dx + Ey + F = 0, by least squares.
  const n = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const rhs = [0, 0, 0];
  const uv = points.map((p) => [dot(sub(p, c), e1), dot(sub(p, c), e2)]);
  for (const [u, v] of uv) {
    const row = [u, v, 1];
    const b = -(u * u + v * v);
    for (let i = 0; i < 3; i++) {
      rhs[i] += row[i] * b;
      for (let j = 0; j < 3; j++) n[i][j] += row[i] * row[j];
    }
  }
  const [d, e, f] = solve3(n, rhs);
  const cu = -d / 2;
  const cv = -e / 2;
  const radius = Math.sqrt(Math.max(0, cu * cu + cv * cv - f));
  const residual = Math.sqrt(uv.reduce((sum, [u, v]) => sum + (Math.hypot(u - cu, v - cv) - radius) ** 2, 0) / uv.length);
  return { center: add(c, add(mul(e1, cu), mul(e2, cv))), normal, radius, count: points.length, residual };
}

function solve3(a: number[][], b: number[]): number[] {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col || m[col][col] === 0) continue;
      const f = m[r][col] / m[col][col];
      for (let k = col; k < 4; k++) m[r][k] -= f * m[col][k];
    }
  }
  return [0, 1, 2].map((i) => m[i][3] / m[i][i]);
}

/**
 * Rings of corners around the axis: corners at the same position along it and the same distance
 * from it, spread all the way round.
 */
function rings(m: TriangleMesh, axis: Axis, within: number): Ring[] {
  const { s, r, x, y } = cylindrical(m, axis, angleReference(axis));
  const order = Array.from(s.keys()).sort((a, b) => s[a] - s[b]);
  const found: Ring[] = [];
  let start = 0;
  for (let i = 1; i <= order.length; i++) {
    if (i < order.length && s[order[i]] - s[order[i - 1]] <= within) continue;
    // order[start..i) share a position along the axis; split them by distance from it.
    const group = order.slice(start, i).sort((a, b) => r[a] - r[b]);
    let from = 0;
    for (let j = 1; j <= group.length; j++) {
      if (j < group.length && r[group[j]] - r[group[j - 1]] <= within) continue;
      const ring = group.slice(from, j);
      from = j;
      if (ring.length < 8 || r[ring[0]] < 1) continue;
      // All the way round: no gap of more than 60 degrees between neighbouring corners.
      const angles = ring.map((k) => Math.atan2(y[k], x[k])).sort((a, b) => a - b);
      let gap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
      for (let k = 1; k < angles.length; k++) gap = Math.max(gap, angles[k] - angles[k - 1]);
      if (gap > Math.PI / 3) continue;
      const fit = fitCircle(ring.map((k) => [m.vertices[3 * k], m.vertices[3 * k + 1], m.vertices[3 * k + 2]] as V3));
      if (fit.residual > within + 1e-6 * fit.radius) continue;
      found.push(fit);
    }
    start = i;
  }
  return found;
}

/**
 * The axis of a part that is (mostly) a solid of revolution: its axis of inertia, then made exact
 * from the rings of corners around it. Throws if the part isn't turned around an axis.
 */
export function findAxis(m: TriangleMesh): Axis {
  let axis = inertiaAxis(m);
  let size = 0;
  for (let i = 0; i < m.vertices.length; i++) size = Math.max(size, Math.abs(m.vertices[i] - axis.point[i % 3]));
  // How close corners have to be to count as one ring, from loose (the axis of inertia can be a
  // little off when the part has holes or pockets) to tight.
  let within = 0.002 * size;
  for (let pass = 0; pass < 6; pass++) {
    const found = rings(m, axis, within);
    if (found.length < 2) {
      if (pass === 0) throw new Error("This part isn't round: no rings of corners go all the way round its axis.");
      break;
    }
    let dir: V3 = [0, 0, 0];
    let point: V3 = [0, 0, 0];
    let weight = 0;
    for (const ring of found) {
      const n = dot(ring.normal, axis.dir) < 0 ? mul(ring.normal, -1) : ring.normal;
      dir = add(dir, mul(n, ring.count));
      point = add(point, mul(ring.center, ring.count));
      weight += ring.count;
    }
    axis = { point: mul(point, 1 / weight), dir: unit(dir) };
    within = Math.max(within / 10, 1e-6 * size);
  }
  return axis;
}

// ---------------------------------------------------------------------------------------------
// The outline

export interface OutlinePoint {
  s: number;
  r: number;
}

/**
 * The outline of the part's outside along its axis, from one end to the other: at each position
 * the largest distance from the axis that the surface reaches, all the way round. A face square
 * to the axis (a step, an end) shows as two points at the same s. Holes don't change it as long as
 * some of the surface is left all round, so this is the solid of revolution the part is made from.
 *
 * Only corners are used, and they lie on the real surface; between two corners along the axis the
 * outline is a straight line, which is exact for cylinders and cones and within the mesh's
 * tolerance for curves.
 */
export function outline(m: TriangleMesh, axis: Axis, same: number): OutlinePoint[] {
  const { s, r } = cylindrical(m, axis, angleReference(axis));
  const n = s.length;
  const order = Array.from(s.keys()).sort((a, b) => s[a] - s[b]);
  // Positions along the axis where corners are (corners closer than `same` share one).
  const at = new Int32Array(n);
  const where: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = order[i];
    if (i === 0 || s[k] - s[order[i - 1]] > same) where.push(s[k]);
    at[k] = where.length - 1;
  }
  const K = where.length;
  const top = new Float64Array(K).fill(-Infinity); // the largest radius right at each position
  const left = new Float64Array(K).fill(-Infinity); // ...just before it
  const right = new Float64Array(K).fill(-Infinity); // ...just after it
  for (let i = 0; i < n; i++) top[at[i]] = Math.max(top[at[i]], r[i]);
  // The smallest of the corners' radii over any run of positions, quickly (a sparse table): an
  // edge can't raise the outline where corners already reach as far out as both its ends.
  const lowest: Float64Array[] = [Float64Array.from(top)];
  for (let span = 1; 2 * span <= K; span *= 2) {
    const prev = lowest[lowest.length - 1];
    const next = new Float64Array(K - 2 * span + 1);
    for (let i = 0; i < next.length; i++) next[i] = Math.min(prev[i], prev[i + span]);
    lowest.push(next);
  }
  const lowestIn = (lo: number, hi: number) => {
    const level = Math.floor(Math.log2(hi - lo + 1));
    return Math.min(lowest[level][lo], lowest[level][hi - (1 << level) + 1]);
  };
  const v = m.vertices;
  const [px, py, pz] = axis.point;
  const [ux, uy, uz] = axis.dir;
  const t = m.triangles;
  for (let tri = 0; tri < t.length; tri += 3) {
    for (let e = 0; e < 3; e++) {
      let a = t[tri + e];
      let b = t[tri + ((e + 1) % 3)];
      if (at[a] === at[b]) continue;
      if (at[a] > at[b]) [a, b] = [b, a];
      right[at[a]] = Math.max(right[at[a]], r[a]);
      left[at[b]] = Math.max(left[at[b]], r[b]);
      if (at[b] - at[a] < 2 || lowestIn(at[a] + 1, at[b] - 1) >= Math.max(r[a], r[b])) continue;
      // Where the edge passes positions between its ends, the radius it has there.
      for (let k = at[a] + 1; k < at[b]; k++) {
        const f = (where[k] - s[a]) / (s[b] - s[a]);
        const qx = v[3 * a] + f * (v[3 * b] - v[3 * a]) - px;
        const qy = v[3 * a + 1] + f * (v[3 * b + 1] - v[3 * a + 1]) - py;
        const qz = v[3 * a + 2] + f * (v[3 * b + 2] - v[3 * a + 2]) - pz;
        const along = qx * ux + qy * uy + qz * uz;
        const rad = Math.hypot(qx - along * ux, qy - along * uy, qz - along * uz);
        if (rad > top[k]) top[k] = rad;
        if (rad > left[k]) left[k] = rad;
        if (rad > right[k]) right[k] = rad;
      }
    }
  }
  const points: OutlinePoint[] = [];
  const push = (sv: number, rv: number) => {
    const last = points[points.length - 1];
    if (!Number.isFinite(rv) || (last && Math.abs(last.s - sv) <= same && Math.abs(last.r - rv) <= same)) return;
    points.push({ s: sv, r: rv });
  };
  for (let k = 0; k < K; k++) {
    if (k > 0) push(where[k], left[k]);
    push(where[k], top[k]);
    if (k < K - 1) push(where[k], right[k]);
  }
  return points;
}
