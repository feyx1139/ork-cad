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
  return part;
}

// Written the way OpenRocket writes them: the tab first, then the fin's size.
const tab = (rel: string, offset: number, length = 0.04) =>
  `<tabheight>0.01</tabheight><tablength>${length}</tablength>` +
  `<tabposition relativeto="${{ top: "front", middle: "center", bottom: "end" }[rel]}">${offset}</tabposition>` +
  `<tabposition relativeto="${rel}">${offset}</tabposition>`;
const trapezoid = `<rootchord>0.08</rootchord><tipchord>0.04</tipchord><height>0.05</height><sweeplength>0.02</sweeplength>`;
const elliptical = (root: number) => `<rootchord>${root}</rootchord><height>0.05</height>`;
const freeform = `<finpoints><point x="0.0" y="0.0"/><point x="0.02" y="0.03"/><point x="0.06" y="0.03"/><point x="0.08" y="0.0"/></finpoints>`;
type Tab = { start: number; length: number } | null;
const same = (a: Tab, b: { start: number; length: number }) =>
  assert.ok(a && Math.abs(a.start - b.start) < 1e-9 && Math.abs(a.length - b.length) < 1e-9, JSON.stringify(a));

test("fin tabs are where OpenRocket puts them when it opens the file", () => {
  // Trapezoidal and freeform fin sets place their tab again once they know their size: a 40 mm tab
  // in the middle of an 80 mm root starts 20 mm back.
  same(finTab("trapezoidfinset", trapezoid, tab("middle", 0)).openRocketTab, { start: 20, length: 40 });
  same(finTab("trapezoidfinset", trapezoid, tab("bottom", -0.005)).openRocketTab, { start: 35, length: 40 });
  same(finTab("freeformfinset", freeform, tab("middle", 0)).openRocketTab, { start: 20, length: 40 });
  // Elliptical ones keep the place worked out on a 50 mm fin: 15 mm further forward.
  same(finTab("ellipticalfinset", elliptical(0.08), tab("middle", 0)).openRocketTab, { start: 5, length: 40 });
  same(finTab("ellipticalfinset", elliptical(0.08), tab("bottom", 0)).openRocketTab, { start: 10, length: 40 });
  // Measured from the fin's front, the fin's length doesn't matter.
  same(finTab("ellipticalfinset", elliptical(0.08), tab("top", 0.01)).openRocketTab, { start: 10, length: 40 });
  // On a 30 mm fin the tab placed for 50 mm runs past the root's end, so OpenRocket shortens it
  // (and a freeform fin set then centres the shorter tab).
  same(finTab("ellipticalfinset", elliptical(0.03), tab("middle", 0)).openRocketTab, { start: 5, length: 25 });
  const short = `<finpoints><point x="0.0" y="0.0"/><point x="0.01" y="0.03"/><point x="0.02" y="0.03"/><point x="0.03" y="0.0"/></finpoints>`;
  same(finTab("freeformfinset", short, tab("middle", 0)).openRocketTab, { start: 2.5, length: 25 });
});

test("an elliptical fin's tab is built where it was designed", () => {
  // Where the saved position puts it, not where OpenRocket moves it on opening, with a note.
  for (const [rel, start, moved] of [["middle", 20, 15], ["bottom", 40, 30]] as const) {
    const fins = finTab("ellipticalfinset", elliptical(0.08), tab(rel, 0));
    same(fins.tab, { start, length: 40 });
    assert.match(fins.tabNote, new RegExp(`built where the file has it, .* ${moved} mm further forward after opening`));
  }
  const fromTop = finTab("ellipticalfinset", elliptical(0.08), tab("top", 0.01));
  same(fromTop.tab, { start: 10, length: 40 });
  assert.equal(fromTop.tabNote, "");
  // Designed 12 mm from the front of an 80 mm root (0.002 from the middle), then opened and
  // saved once or twice: 15 mm further forward each time, so as saved it sticks out in front of the
  // fin. It's put back.
  for (const [times, offset, openedAt] of [[1, -0.013, -18], [2, -0.028, -33]] as const) {
    const fins = finTab("ellipticalfinset", elliptical(0.08), tab("middle", offset, 0.06));
    same(fins.tab, { start: 12, length: 60 });
    same(fins.openRocketTab, { start: openedAt, length: 60 });
    assert.match(fins.tabNote, new RegExp(`put back where it was designed, 12 to 72 mm .* has moved ${times === 1 ? "once" : "2 times"}.* 12 mm relative to the top`));
  }
  // Longer than the root: only the part along the root.
  const long = finTab("ellipticalfinset", elliptical(0.03), tab("middle", 0));
  same(long.tab, { start: 0, length: 30 });
  assert.match(long.tabNote, /runs past the fin's root/);
});
