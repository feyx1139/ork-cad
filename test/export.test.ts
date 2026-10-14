// The STEP files must read back as the same solids, in millimetres and in place.

import { before, test } from "node:test";
import assert from "node:assert/strict";
import { importSTEP, type Shape3D } from "replicad";
import { exportRocket } from "../src/export/step.ts";
import { solidVolume } from "../src/geometry/measure.ts";
import { initOpenCascadeNode, loadOrkFile } from "../src/node/load.ts";
import { fixture, ROCKETS } from "./helpers.ts";

before(() => initOpenCascadeNode());

for (const rocket of ROCKETS) {
  test(`${rocket}: every STEP file re-imports with the same volume and position`, async (t) => {
    const model = await loadOrkFile(fixture(`${rocket}.ork`));
    const result = exportRocket(model);
    let total = 0;
    for (const p of result.parts) {
      const back = (await importSTEP(p.step)) as Shape3D;
      const volume = solidVolume(back);
      assert.ok(Math.abs(volume / p.volume - 1) < 1e-7, `${p.fileName}: volume ${volume} vs ${p.volume}`);
      assert.equal(back.solids.length, p.pieces, `${p.fileName}: solids`);
      // Inside the rocket's envelope: Z from the tail (0) to the tip.
      const [[, , zmin], [, , zmax]] = back.boundingBox.bounds;
      assert.ok(zmin > -1e-3 && zmax < model.length + 1e-3, `${p.fileName}: Z ${zmin}..${zmax} outside the rocket`);
      total += volume;
    }
    // The assembly holds every copy of every part.
    const all = (await importSTEP(result.assembly)) as Shape3D;
    const pieces = result.parts.reduce((n, p) => n + p.pieces, 0);
    assert.equal(all.solids.length, pieces, "solids in assembly.step");
    const assemblyVolume = solidVolume(all);
    assert.ok(Math.abs(assemblyVolume / total - 1) < 1e-7, `assembly volume ${assemblyVolume} vs ${total}`);
    const [[, , zmin], [, , zmax]] = all.boundingBox.bounds;
    t.diagnostic(`${result.parts.length} part files, ${pieces} solids, assembly spans Z ${zmin.toFixed(3)} to ${zmax.toFixed(3)} mm`);
  });
}
