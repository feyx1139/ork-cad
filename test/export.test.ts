// The files. Every STL must be a closed surface holding one copy of its part, with its corners on
// the exact surface and its volume within what the triangles' 0.01 mm allowance can change. The
// STEP files (when asked for) must read back as the same solids, in millimetres and in place.

import { before, test } from "node:test";
import assert from "node:assert/strict";
import { DistanceQuery, importSTEP, makeCompound, makeVertex, type Shape3D } from "replicad";
import { exportRocket, PRINT_MESH } from "../src/export/files.ts";
import { buildPart } from "../src/geometry/parts.ts";
import { solidVolume } from "../src/geometry/measure.ts";
import { badEdges, meshArea, meshVolume, readSTL } from "../src/geometry/stl.ts";
import { initOpenCascadeNode, loadOrkFile } from "../src/node/load.ts";
import { fixture, ROCKETS } from "./helpers.ts";

before(() => initOpenCascadeNode());

for (const rocket of ROCKETS) {
  test(`${rocket}: every STL is one closed copy of its part, on the exact surface`, async (t) => {
    const model = await loadOrkFile(fixture(`${rocket}.ork`));
    const result = exportRocket(model);
    for (const p of result.parts) {
      const mesh = readSTL(p.stl);
      assert.equal(badEdges(mesh), 0, `${p.fileName}: not a closed surface`);
      const exact = buildPart(p.part, model)!.solids[0];
      // No point of a triangle is further than the tolerance from the surface, so the volume can't
      // change by more than that over the whole area.
      const volume = solidVolume(exact);
      const allowed = meshArea(mesh) * PRINT_MESH.tolerance;
      const diff = meshVolume(mesh) - volume;
      assert.ok(Math.abs(diff) <= allowed, `${p.fileName}: ${meshVolume(mesh)} mm³ vs ${volume} (±${allowed})`);
      // Corners are on the exact surface, up to the 32-bit numbers STL files store.
      const query = new DistanceQuery(makeCompound(exact.faces));
      const n = mesh.vertices.length / 3;
      let worst = 0;
      for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 200))) {
        const v = makeVertex([mesh.vertices[3 * i], mesh.vertices[3 * i + 1], mesh.vertices[3 * i + 2]]);
        worst = Math.max(worst, query.distanceTo(v));
        v.delete();
      }
      assert.ok(worst < 1e-4, `${p.fileName}: a corner is ${worst} mm off the surface`);
      t.diagnostic(`${p.fileName}: ${mesh.triangles.length / 3} triangles, volume off by ${((diff / volume) * 100).toFixed(4)}%`);
    }
  });

  test(`${rocket}: every STEP file re-imports with the same volume and position`, async (t) => {
    const model = await loadOrkFile(fixture(`${rocket}.ork`));
    const result = exportRocket(model, { step: true });
    let total = 0;
    for (const p of result.parts) {
      const back = (await importSTEP(new Blob([p.step!.slice()]))) as Shape3D;
      const volume = solidVolume(back);
      assert.ok(Math.abs(volume / p.volume - 1) < 1e-7, `${p.fileName}: volume ${volume} vs ${p.volume}`);
      assert.equal(back.solids.length, p.pieces, `${p.fileName}: solids`);
      // Inside the rocket's envelope: Z from the tail (0) to the tip.
      const [[, , zmin], [, , zmax]] = back.boundingBox.bounds;
      assert.ok(zmin > -1e-3 && zmax < model.length + 1e-3, `${p.fileName}: Z ${zmin}..${zmax} outside the rocket`);
      total += volume;
    }
    // The assembly holds every copy of every part.
    const all = (await importSTEP(new Blob([result.assembly!.slice()]))) as Shape3D;
    const pieces = result.parts.reduce((n, p) => n + p.pieces, 0);
    assert.equal(all.solids.length, pieces, "solids in assembly.step");
    const assemblyVolume = solidVolume(all);
    assert.ok(Math.abs(assemblyVolume / total - 1) < 1e-7, `assembly volume ${assemblyVolume} vs ${total}`);
    const [[, , zmin], [, , zmax]] = all.boundingBox.bounds;
    t.diagnostic(`${result.parts.length} part files, ${pieces} solids, assembly spans Z ${zmin.toFixed(3)} to ${zmax.toFixed(3)} mm`);

    // It's an assembly: the rocket, with a named component for every copy of every part, so CAD
    // programs list them separately. In millimetres, coloured like the website.
    const text = new TextDecoder().decode(result.assembly!);
    const products = [...text.matchAll(/PRODUCT\('((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
    const names = result.parts.flatMap((p) => (p.copies > 1 ? Array.from({ length: p.copies }, (_, i) => `${p.part.name} ${i + 1}`) : [p.part.name]));
    assert.deepEqual(products.slice().sort(), [model.name, ...names].sort(), "a product per piece, and the rocket");
    assert.equal((text.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\(/g) ?? []).length, names.length, "every piece is a component of the rocket");
    assert.match(text, /SI_UNIT\(\.MILLI\.,\.METRE\.\)/);
    assert.match(text, /COLOUR_RGB/);
  });
}
