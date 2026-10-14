// The parsed model must place every component exactly where OpenRocket does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { allParts } from "../src/ork/model.ts";
import { loadOrkFile, modelFromBytes } from "../src/node/load.ts";
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

/** A body tube carrying one fin set given as XML, in an otherwise empty rocket. */
function finRocket(fins: string): string {
  return `<?xml version='1.0' encoding='utf-8'?>
<openrocket version="1.10" creator="OpenRocket 24.12"><rocket><name>Fins</name><id>r</id>
<subcomponents><stage><name>Sustainer</name><id>s</id><subcomponents>
<bodytube><name>Body tube</name><id>b</id><length>0.3</length><thickness>0.0005</thickness><radius>0.0125</radius>
<subcomponents>${fins}</subcomponents></bodytube>
</subcomponents></stage></subcomponents></rocket></openrocket>`;
}

function finTab(tag: string, shape: string, tab: string) {
  const xml = finRocket(`<${tag}><name>Fins</name><id>f</id><fincount>3</fincount>
    <axialoffset method="bottom">0.0</axialoffset><position type="bottom">0.0</position>
    <thickness>0.003</thickness><crosssection>square</crosssection><cant>0.0</cant>
    ${tab}<filletradius>0.0</filletradius>${shape}</${tag}>`);
  const part = allParts(modelFromBytes(new TextEncoder().encode(xml))).find((p) => p.name === "Fins")!;
  assert.ok(part.kind === "finset");
  return { start: part.tab!.start, length: part.tab!.length, moved: part.tabMoved };
}

test("fin tabs are where OpenRocket puts them when it opens the file", () => {
  // Written the way OpenRocket writes them: the tab first, then the fin's size.
  const tab = (rel: string, offset: number, length = 0.04) =>
    `<tabheight>0.01</tabheight><tablength>${length}</tablength>` +
    `<tabposition relativeto="${{ top: "front", middle: "center", bottom: "end" }[rel]}">${offset}</tabposition>` +
    `<tabposition relativeto="${rel}">${offset}</tabposition>`;
  const trapezoid = `<rootchord>0.08</rootchord><tipchord>0.04</tipchord><height>0.05</height><sweeplength>0.02</sweeplength>`;
  const elliptical = (root: number) => `<rootchord>${root}</rootchord><height>0.05</height>`;
  const freeform = `<finpoints><point x="0.0" y="0.0"/><point x="0.02" y="0.03"/><point x="0.06" y="0.03"/><point x="0.08" y="0.0"/></finpoints>`;
  const near = (a: { start: number; length: number; moved: number }, b: typeof a) =>
    assert.ok(Math.abs(a.start - b.start) < 1e-9 && Math.abs(a.length - b.length) < 1e-9 && Math.abs(a.moved - b.moved) < 1e-9, JSON.stringify(a));

  // Trapezoidal and freeform fin sets place their tab again once they know their size: a 40 mm tab
  // in the middle of an 80 mm root starts 20 mm back.
  near(finTab("trapezoidfinset", trapezoid, tab("middle", 0)), { start: 20, length: 40, moved: 0 });
  near(finTab("trapezoidfinset", trapezoid, tab("bottom", -0.005)), { start: 35, length: 40, moved: 0 });
  near(finTab("freeformfinset", freeform, tab("middle", 0)), { start: 20, length: 40, moved: 0 });
  // Elliptical ones keep the place worked out on a 50 mm fin: 15 mm further forward.
  near(finTab("ellipticalfinset", elliptical(0.08), tab("middle", 0)), { start: 5, length: 40, moved: -15 });
  near(finTab("ellipticalfinset", elliptical(0.08), tab("bottom", 0)), { start: 10, length: 40, moved: -30 });
  // Measured from the fin's front, the fin's length doesn't matter.
  near(finTab("ellipticalfinset", elliptical(0.08), tab("top", 0.01)), { start: 10, length: 40, moved: 0 });
  // On a 30 mm fin the tab placed for 50 mm runs past the root's end, so OpenRocket shortens it
  // (and a freeform fin set then centres the shorter tab).
  near(finTab("ellipticalfinset", elliptical(0.03), tab("middle", 0)), { start: 5, length: 25, moved: 10 });
  const short = `<finpoints><point x="0.0" y="0.0"/><point x="0.01" y="0.03"/><point x="0.02" y="0.03"/><point x="0.03" y="0.0"/></finpoints>`;
  near(finTab("freeformfinset", short, tab("middle", 0)), { start: 2.5, length: 25, moved: 0 });
});
