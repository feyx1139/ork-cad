// ork-cad's automatic details (src/features/auto.ts), on a small ARC-style test design
// (fixtures/details/printed-transition.ork): a printed, solid nose cone; a paper payload tube with
// the eggs and a launch lug at 45 degrees; a printed, solid 12 mm band between two 65 mm tubes,
// with OpenRocket's altimeter (16 mm across, 36 mm long) inside its 40 mm fore shoulder; and a
// booster with the shock cord, parachute, motor mount and four fins.

import { before, test } from "node:test";
import assert from "node:assert/strict";
import { DistanceQuery, makeCompound, makeVertex } from "replicad";
import { allParts, type Part, type RocketModel, type TransitionPart } from "../src/ork/model.ts";
import { addAutoDetails } from "../src/features/auto.ts";
import { parseFeatures } from "../src/features/parse.ts";
import { findCompartments } from "../src/checks/compartments.ts";
import { buildPart } from "../src/geometry/parts.ts";
import { solidVolume } from "../src/geometry/measure.ts";
import { initOpenCascadeNode, loadOrkFile } from "../src/node/load.ts";
import { fixture } from "./helpers.ts";

before(() => initOpenCascadeNode());

const FILE = fixture("details/printed-transition.ork");

async function load(comments: Record<string, string> = {}): Promise<{ model: RocketModel; named: (name: string) => Part }> {
  const model = await loadOrkFile(FILE);
  const named = (name: string) => allParts(model).find((p) => p.name === name)!;
  for (const [name, comment] of Object.entries(comments)) {
    const { features, auto, errors } = parseFeatures(comment);
    assert.deepEqual(errors, []);
    Object.assign(named(name), { comment, features, autoSettings: auto });
  }
  addAutoDetails(model);
  return { model, named };
}

const lines = (p: Part) => p.features.filter((f) => f.auto).map((f) => f.source);

test("a printed transition with the altimeter in it gets a pocket, vents, an eyebolt nut and lead-ins", async () => {
  const { named } = await load();
  assert.deepEqual(lines(named("Altimeter band")), [
    "@round end=fore radius=3.1",
    "@chamfer end=aft inset=3.1 angle=30 round=4.6",
    "@pocket size=17x17 depth=49 end=fore round=3",
    "@nut-trap size=M4 depth=12 end=aft",
    "@side-holes count=4 diameter=1.1 at=6 angle=0",
  ]);
  // The nose cone is printed too: a lead-in on its shoulder, and nothing else.
  assert.deepEqual(lines(named("Nose cone")), ["@chamfer end=aft inset=3.1 angle=30 round=4.6"]);
  // Paper tubes and the rest get nothing.
  for (const name of ["Payload tube", "Booster", "Fins"]) assert.deepEqual(lines(named(name)), [], name);
  const why = Object.fromEntries(named("Altimeter band").features.map((f) => [f.kind, f.auto!]));
  assert.match(why.pocket, /Altimeter \(16 mm across, 36 mm long\)/);
  assert.match(why.pocket, /opens at the fore end \(away from the motor's ejection charge\)/);
  assert.match(why.pocket, /past the middle of the band so vents through the band open into it/);
  assert.match(why["nut-trap"], /shock cord \(Shock cord\) is next to the aft end/);
  assert.match(why["side-holes"], /four is best \(never two\)/);
});

test("the pocket goes past the altimeter and the middle of the band; the vents are sized for the space", async () => {
  const { model, named } = await load();
  // The altimeter ends 37 mm into the fore shoulder; the band's middle is 46 mm in.
  const band = named("Altimeter band") as TransitionPart;
  const alt = named("Altimeter");
  const foreFace = band.instances[0].x - band.foreShoulder.length;
  assert.equal(alt.instances[0].x + alt.length - foreFace, 37);
  assert.equal(band.foreShoulder.length + band.length / 2 + 3, 49);
  // The altimeter's sealed space: the payload tube from the nose cone's shoulder down to the
  // bottom of the pocket, plus the pocket.
  const space = findCompartments(model).compartments.find((c) => c.altimeter)!;
  assert.deepEqual([space.from, space.to], [155, 419]);
  const air = Math.PI * 32 ** 2 * (370 - 155) + 17 * 17 * 49;
  assert.ok(Math.abs(space.volume - air) < 1e-6 * air, `${space.volume} vs ${air}`);
  // PerfectFlite: one hole of 0.0016 * 4V/pi inches for V cubic inches, or four of half that.
  const four = ((0.0016 * 4 * (air / 16387.064)) / Math.PI / 2) * 25.4;
  assert.equal(Math.round(four * 10) / 10, 1.1);
  assert.deepEqual(space.vents, ["Altimeter band: 4 x 1.1 mm"]);
  assert.deepEqual(findCompartments(model).warnings, []);
});

test("the vents turn away from the launch lug ahead of them", async () => {
  const { model, named } = await load();
  // The lug is at 45 degrees: the vents go to 0, 90, 180 and 270, as far from it as four can be.
  assert.match(lines(named("Altimeter band")).at(-1)!, /angle=0$/);
  // With the lug turned to 0, they go between, at 45.
  const lug = named("Launch lug");
  lug.instances = lug.instances.map((i) => ({ ...i, angle: 0 }));
  addAutoDetails(model);
  assert.match(lines(named("Altimeter band")).at(-1)!, /angle=45$/);
});

test("built, it is one solid; the vents open into the pocket and its mouth is rounded", async () => {
  const { model, named } = await load();
  const band = named("Altimeter band") as TransitionPart;
  const built = buildPart(band, model)!;
  assert.equal(built.solids.length, 1);
  const solid = built.solids[0];
  assert.equal(solid.solids?.length ?? 1, 1);
  assert.ok(built.warnings.some((w) => /1\.1 mm holes come out smaller than drawn/.test(w)), built.warnings.join("\n"));
  // In the middle of the band (Z = 722 - 416), 26 mm out: on a vent's axis that's 0.55 mm from
  // the hole's wall; between two vents it's in plastic, 6.5 mm in from the outside.
  const query = new DistanceQuery(makeCompound(solid.faces));
  const at = (deg: number) => query.distanceTo(makeVertex([26 * Math.cos((deg * Math.PI) / 180), 26 * Math.sin((deg * Math.PI) / 180), 722 - 416]));
  for (const deg of [0, 90, 180, 270]) assert.ok(Math.abs(at(deg) - 0.55) < 1e-6, `vent at ${deg}: ${at(deg)}`);
  assert.ok(Math.abs(at(45) - 6.5) < 1e-6, `${at(45)}`);
  // The rounded mouth takes away the round's cross-section along the four sides, and at each
  // sharp corner the two sides' rounds run into each other (as a CAD fillet does).
  const sharp = band.features.map((f) => (f.kind === "pocket" ? { ...f, round: 0 } : f));
  const rho = 3;
  const flare = rho ** 2 * (1 - Math.PI / 4) * 4 * 17 + 4 * (5 / 3 - Math.PI / 2) * rho ** 3;
  const removed = solidVolume(buildPart({ ...band, features: sharp }, model)!.solids[0]) - solidVolume(solid);
  assert.ok(Math.abs(removed - flare) < 1e-6, `${removed} vs ${flare}`);
});

test("@auto turns them off; a line of the same kind takes the place of the automatic one", async () => {
  const off = await load({ "Altimeter band": "@auto off" });
  assert.deepEqual(lines(off.named("Altimeter band")), []);
  assert.deepEqual(lines(off.named("Nose cone")), ["@chamfer end=aft inset=3.1 angle=30 round=4.6"], "only that part");

  // No vents in the band: the pocket stops 3 mm past the altimeter, and the vents go in the
  // payload tube instead, 10 mm clear of the band's shoulder (closer behind the nose than is best).
  const noVents = await load({ "Altimeter band": "@auto vents=off" });
  assert.deepEqual(lines(noVents.named("Altimeter band")), [
    "@round end=fore radius=3.1",
    "@chamfer end=aft inset=3.1 angle=30 round=4.6",
    "@pocket size=17x17 depth=40 end=fore round=3",
    "@nut-trap size=M4 depth=12 end=aft",
  ]);
  const moved = noVents.named("Payload tube").features.find((f) => f.auto)!;
  assert.equal(moved.source, "@side-holes count=4 diameter=1.1 at=250 angle=0");
  assert.match(moved.auto!, /closer behind the nose cone than the 4 body diameters PerfectFlite advises/);
  // Off there too: no automatic vents at all, and the sealed-space check says so.
  const none = await load({ "Altimeter band": "@auto vents=off", "Payload tube": "@auto vents=off" });
  assert.ok(allParts(none.model).every((p) => !p.features.some((f) => f.auto && f.kind === "side-holes")));
  assert.match(findCompartments(none.model).warnings.join("\n"), /no vent holes/);

  const own = await load({ "Altimeter band": "@pocket size=20x20 depth=60 end=fore\n@round end=fore radius=1" });
  assert.deepEqual(lines(own.named("Altimeter band")), [
    "@chamfer end=aft inset=3.1 angle=30 round=4.6",
    "@nut-trap size=M4 depth=12 end=aft",
    "@side-holes count=4 diameter=1.1 at=6 angle=0",
  ]);

  // Vents of your own into the altimeter's space, anywhere: no automatic ones.
  const vents = await load({ "Payload tube": "@side-holes count=3 diameter=1 at=200" });
  assert.deepEqual(lines(vents.named("Altimeter band")).map((l) => l.split(" ")[0]), ["@round", "@chamfer", "@pocket", "@nut-trap"]);
});

test("a hollow transition gets lead-ins sized for its wall, and a note about ticking Filled", async () => {
  const model = await loadOrkFile(FILE);
  const band = allParts(model).find((p) => p.name === "Altimeter band") as TransitionPart;
  band.filled = false;
  band.thickness = 2;
  addAutoDetails(model);
  assert.deepEqual(lines(band).slice(0, 2), ["@round end=fore radius=1", "@chamfer end=aft inset=1 angle=45"]);
  assert.ok(!band.features.some((f) => f.kind === "pocket" || f.kind === "nut-trap"));
  assert.equal(band.autoNotes!.length, 1);
  assert.match(band.autoNotes![0], /hollow in OpenRocket, so ork-cad can't give it a pocket for the altimeter \(Altimeter\) or a captive nut/);
  assert.match(band.autoNotes![0], /Tick "Filled" for it in OpenRocket .* and it will\./);
});

test("automatic details are only added on request", async () => {
  const model = await loadOrkFile(FILE);
  assert.ok(allParts(model).every((p) => p.features.length === 0));
  const auto = await loadOrkFile(FILE, { auto: true });
  assert.ok(allParts(auto).some((p) => p.features.some((f) => f.auto)));
});
