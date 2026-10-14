// The sealed spaces inside OpenRocket's "ARC payload rocket" example, what is in them, and the
// vent checks. Its payload bay (between the solid nose cone and the coupler's bulkhead) holds a
// mass component; named "Altimeter", it stands in for a flight computer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { allParts, type CylinderPart, type Part } from "../src/ork/model.ts";
import { parseFeatures } from "../src/features/parse.ts";
import { findCompartments } from "../src/checks/compartments.ts";
import { loadOrkFile } from "../src/node/load.ts";
import { fixture } from "./helpers.ts";

async function arc(options: { altimeter?: boolean; details?: Record<string, string> } = {}) {
  const model = await loadOrkFile(fixture("arc-payload-rocket.ork"));
  const parts = allParts(model);
  const named = (name: string) => parts.filter((p) => p.name === name);
  if (options.altimeter) named("Mass component")[0].name = "Altimeter";
  for (const [name, line] of Object.entries(options.details ?? {})) {
    // Two parts are called "Body tube": the payload tube comes first.
    named(name)[0].features = parseFeatures(line).features;
  }
  return { model, named };
}

const names = (c: { contents: Part[] }) => c.contents.map((p) => p.name);
const span = (c: { from: number; to: number }) => [Number(c.from.toFixed(2)), Number(c.to.toFixed(2))];

test("ARC example: the sealed spaces and what is in them", async () => {
  const { model, named } = await arc();
  const { compartments, warnings, notes } = findCompartments(model);
  // Nose cone (solid, with its shoulder) to 198.12; bulkhead 352.425-355.6; centering rings
  // 937.8-939.8 and 1052.1-1054.1; open tail at 1066.8.
  assert.deepEqual(compartments.map(span), [
    [198.12, 352.42],
    [355.6, 937.8],
    [939.8, 1052.1],
    [1054.1, 1066.8],
  ]);
  const [payload, recovery] = compartments;
  assert.deepEqual(names(payload), ["Mass component"]);
  assert.ok(!payload.altimeter && !payload.ejection);
  assert.deepEqual(names(recovery), ['Elliptical 12-Gore 12" Parachute', 'Elliptical 12-Gore 15" Parachute']);
  assert.ok(recovery.ejection);
  // Air in the payload bay: the payload tube's inside down to the coupler, then the coupler's.
  const tube = named("Body tube")[0] as CylinderPart;
  const coupler = named("Tube coupler")[0] as CylinderPart;
  const c0 = coupler.instances[0].x;
  const expected = Math.PI * (tube.innerRadius ** 2 * (c0 - payload.from) + coupler.innerRadius ** 2 * (payload.to - c0));
  assert.ok(Math.abs(payload.volume - expected) < 1e-6, `${payload.volume} vs ${expected}`);
  assert.ok(Math.abs(payload.diameter - 2 * tube.innerRadius) < 1e-9);
  assert.deepEqual(warnings, []);
  assert.deepEqual(notes, []);
});

test("an altimeter in the payload bay needs vent holes", async () => {
  const { model } = await arc({ altimeter: true });
  const { compartments, warnings } = findCompartments(model);
  assert.ok(compartments[0].altimeter);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /altimeter is in the space 198\.1–352\.4 mm .*\(after Nose cone, up to Bulkhead\), which has no vent holes/);
});

test("holes in the payload tube vent the altimeter", async () => {
  const { model } = await arc({ altimeter: true, details: { "Body tube": "@side-holes count=3 diameter=2 at=30" } });
  const { compartments, warnings } = findCompartments(model);
  assert.deepEqual(compartments[0].vents, ["Body tube: 3 x 2 mm"]);
  assert.deepEqual(compartments[1].vents, []);
  assert.deepEqual(warnings, []);
});

test("holes into the parachute space get a note: they let some ejection pressure out", async () => {
  const { model, named } = await arc();
  named("Body tube")[1].features = parseFeatures("@side-holes count=2 diameter=2 at=100").features;
  const { compartments, warnings, notes } = findCompartments(model);
  assert.deepEqual(compartments[1].vents, ["Body tube: 2 x 2 mm"]);
  assert.deepEqual(warnings, []);
  assert.match(notes.join("\n"), /open into the space 355\.6–937\.8 mm .*ejection charge fires into/);
});

test("end holes through the bulkhead would let ejection gas reach the altimeter", async () => {
  const { model } = await arc({ altimeter: true, details: { Bulkhead: "@end-holes count=4 diameter=3 radius=15" } });
  const { warnings } = findCompartments(model);
  assert.ok(warnings.some((w) => /End holes in Bulkhead let ejection gas from the motor into the space with the altimeter/.test(w)), warnings.join("\n"));
});
