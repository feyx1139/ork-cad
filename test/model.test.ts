// The parsed model must place every component exactly where OpenRocket does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { allParts } from "../src/ork/model.ts";
import { loadOrkFile } from "../src/node/load.ts";
import { fixture, readReference, ROCKETS } from "./helpers.ts";

const TOL = 1e-6; // mm

for (const rocket of ROCKETS) {
  test(`${rocket}: every component's position, copies and length match OpenRocket`, async () => {
    const model = await loadOrkFile(fixture(`${rocket}.ork`));
    const ref = await readReference(rocket);
    assert.ok(Math.abs(model.length - ref.rocketLength * 1000) < TOL, "rocket length");

    const parts = new Map(allParts(model).map((p) => [p.id, p]));
    assert.equal(parts.size, ref.components.length, "number of components");
    for (const c of ref.components) {
      const p = parts.get(c.id);
      assert.ok(p, `missing ${c.name}`);
      assert.equal(p.instances.length, c.locations.length, `${c.name}: number of copies`);
      c.locations.forEach(([x, y, z], i) => {
        const inst = p.instances[i];
        const d = Math.hypot(inst.x - x * 1000, inst.y - y * 1000, inst.z - z * 1000);
        assert.ok(d < TOL, `${c.name} #${i + 1}: off by ${d} mm`);
      });
      assert.ok(Math.abs(p.length - c.length * 1000) < TOL, `${c.name}: length ${p.length} vs ${c.length * 1000}`);
    }
  });
}
