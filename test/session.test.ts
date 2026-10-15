// The website's design session (web/session.ts), run in Node on OpenRocket's "3D printable nose
// cone and fins" example: open it, build and mesh its parts, edit details, make every download,
// compare a part with a CAD file of the real part and take on its changes, and canted fins' spin.

import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import { Session } from "../web/session.ts";
import { initOpenCascadeNode, modelFromBytes, xmlTools } from "../src/node/load.ts";
import { allParts, type TransitionPart } from "../src/ork/model.ts";
import { fixture } from "./helpers.ts";
import { wallVolume } from "./volumes.ts";
import { parseFeatures } from "../src/features/parse.ts";
import { buildPart } from "../src/geometry/parts.ts";
import { solidVolume } from "../src/geometry/measure.ts";
import { stlOf } from "../src/export/files.ts";
import { decodeOrkBytes } from "../src/ork/read.ts";
import { revsPerSecond, spinLoad, steadyRoll } from "../src/aero/roll.ts";

before(() => initOpenCascadeNode());

const FILE = "3d-printable-nose-cone-and-fins.ork";
const HOLES = "@side-holes count=3 diameter=2 at=60 angle=45";

function open() {
  const session = Session.open(new Uint8Array(readFileSync(fixture(FILE))), FILE, xmlTools);
  const views = session.buildAll();
  const key = (name: string) => views.find((v) => v.name === name)!.key;
  return { session, views, key };
}

test("opening the example builds and meshes every part", () => {
  const { session, views } = open();
  assert.equal(session.rocket.name, "3D printable nose cone and fins");
  assert.deepEqual(
    views.map((v) => v.name),
    [
      "Printable nose cone",
      "Paper Body Tube -- DO NOT PRINT",
      "Printable Fin Can and Motor Mount",
      "Launch lug",
      "Trapezoidal fin set",
      "Centering ring",
      "Centering ring",
      "Inner Tube",
      "Engine block",
      "Tube Coupler",
    ],
  );
  for (const v of views) {
    if (v.name === "Trapezoidal fin set") {
      // Printed fins on the printed fin can are printed as part of it (the example says to export
      // them together), so they're in its shape and have none of their own.
      assert.deepEqual(v.auto.map((a) => a.line), ["@one-piece"]);
      assert.ok(!v.mesh && v.volume === 0 && v.printedWith === "Printable Fin Can and Motor Mount");
      continue;
    }
    assert.ok(v.mesh && v.mesh.triangles.length > 0 && v.mesh.edges.length > 0, `${v.name} mesh`);
    assert.equal(v.mesh.vertices.length, v.mesh.normals.length);
    assert.ok(Math.max(...v.mesh.triangles) < v.mesh.vertices.length / 3, `${v.name} triangle indices`);
    assert.deepEqual(v.errors, []);
  }
  const [nose, paper, finCan] = views;
  const model = modelFromBytes(new Uint8Array(readFileSync(fixture(FILE))));
  const exact = wallVolume(allParts(model).find((p) => p.name === nose.name) as TransitionPart)!;
  // The printed nose cone gets a lead-in on its shoulder by itself: a 45 degree chamfer 1.1 mm in
  // (5% of the 23.9 mm shoulder, which is also half its 2.2 mm wall), a triangle turned around the axis.
  assert.deepEqual(nose.auto.map((a) => a.line), ["@chamfer end=aft inset=1.1 angle=45"]);
  const chamfer = 2 * Math.PI * (11.95 - 1.1 / 3) * (1.1 ** 2 / 2);
  assert.ok(nose.printed && nose.density === 1250 && Math.abs(nose.volume / (exact - chamfer) - 1) < 1e-7, `${nose.volume} vs ${exact - chamfer}`);
  assert.ok(!paper.printed, "the paper tube isn't printed");
  assert.ok(finCan.printed);
  assert.equal(views[4].copies, 3);
});

test("editing details rebuilds the part, keeps notes, and reports problems", () => {
  const { session, views, key } = open();
  const before = views.find((v) => v.name === "Printable nose cone")!.volume;
  const [holed] = session.setDetails(key("Printable nose cone"), HOLES);
  assert.ok(holed.volume < before && before - holed.volume > 10, "holes removed material");
  assert.equal(holed.details, HOLES);
  assert.ok(session.hasEdits);

  const [typo] = session.setDetails(key("Printable nose cone"), "@side-holes count=3 diam=2 at=60");
  assert.match(typo.errors.join("\n"), /unknown setting "diam"/);
  assert.ok(typo.mesh, "still shown");

  const [needsSolid] = session.setDetails(key("Printable nose cone"), "@pocket size=10x8 depth=20 end=aft");
  assert.match(needsSolid.errors.join("\n"), /tick "Filled"/);
  assert.ok(needsSolid.mesh && Math.abs(needsSolid.volume - before) < 1e-6, "shown without the detail, with the automatic one");

  // The centering ring's comment has a note; a line without @ is kept as one too.
  const [ring] = session.setDetails(key("Centering ring"), "drill by hand\n@end-holes count=3 diameter=0.5 radius=11.2");
  assert.match(ring.errors.join("\n"), /doesn't start with @/);
  const comment = session.part(key("Centering ring")).comment;
  assert.ok(comment.startsWith("The centering ring automatically") && comment.includes("drill by hand"), comment);
  assert.ok(comment.endsWith("@end-holes count=3 diameter=0.5 radius=11.2"), comment);
});

test("sealed spaces: the nose, the parachute bay the motor fires into, and the fin can", () => {
  const { session } = open();
  const { spaces, warnings } = session.spaces();
  assert.deepEqual(
    spaces.map((s) => [Number(s.from.toFixed(1)), Number(s.to.toFixed(1))]),
    [
      [0, 117.8],
      [120, 278.6],
      [283.6, 323.6],
    ],
  );
  assert.ok(spaces[1].ejection && spaces[1].contents.includes("Parachute"));
  assert.deepEqual(warnings, []);
});

test("downloads: one part, everything in a zip, and the .ork with details", async () => {
  const { session, key } = open();
  const step = await session.partFile(key("Printable nose cone"), "step");
  assert.equal(step.name, "Printable nose cone.step");
  assert.match(new TextDecoder().decode(step.bytes.slice(0, 20)), /^ISO-10303-21/);
  await assert.rejects(session.partFile(key("Trapezoidal fin set"), "stl"), /printed as part of Printable Fin Can and Motor Mount/);
  const stl = await session.partFile(key("Launch lug"), "stl");
  assert.equal(stl.name, "Launch lug.stl");
  const triangles = new DataView(stl.bytes.buffer, stl.bytes.byteOffset).getUint32(80, true);
  assert.equal(stl.bytes.length, 84 + 50 * triangles, "binary STL");

  session.setDetails(key("Printable nose cone"), HOLES);
  const zip = await session.zip();
  assert.equal(zip.name, "3d-printable-nose-cone-and-fins parts.zip");
  const files = unzipSync(zip.bytes);
  const names = Object.keys(files).sort();
  assert.equal(names.filter((n) => n.endsWith(".stl")).length, 9, "an STL for every part, the fins in the fin can's");
  assert.ok(names.includes("01 Printable nose cone.stl") && names.includes("03 Printable Fin Can and Motor Mount.stl"));
  assert.ok(!names.some((n) => n.includes("Trapezoidal fin set")));
  assert.deepEqual(
    names.filter((n) => !n.endsWith(".stl")),
    ["report.txt"],
    "nothing but the STL files and the report",
  );
  const report = strFromU8(files["report.txt"]);
  assert.match(report, new RegExp(`detail: ${HOLES}`));

  // The whole rocket for Onshape: one STEP file, every part a separate named component.
  const onshape = session.rocketStep();
  assert.equal(onshape.name, "3d-printable-nose-cone-and-fins for Onshape.step");
  const assembly = new TextDecoder().decode(onshape.bytes);
  assert.equal((assembly.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\(/g) ?? []).length, 9, "9 parts, the fins in the fin can");
  assert.match(assembly, /PRODUCT\('Printable nose cone'/);
  assert.doesNotMatch(assembly, /PRODUCT\('Trapezoidal fin set/);

  const saved = session.saveOrk();
  assert.equal(saved.name, FILE);
  const reopened = allParts(modelFromBytes(saved.bytes));
  assert.equal(reopened.find((p) => p.name === "Printable nose cone")!.comment, HOLES);
  const original = allParts(modelFromBytes(new Uint8Array(readFileSync(fixture(FILE)))));
  for (const p of reopened.filter((p) => p.name !== "Printable nose cone")) {
    assert.equal(p.comment, original.find((q) => q.id === p.id)!.comment, p.name);
  }
});

test("comparing the nose cone with an STL of the real one, and taking on its changes", async () => {
  const { session, key } = open();
  const nose = session.part(key("Printable nose cone")) as TransitionPart;
  // The real one has a 25 mm shoulder and three vents.
  const lines = "@side-holes count=3 diameter=2 at=60 angle=45";
  const real = buildPart(
    { ...nose, aftShoulder: { ...nose.aftShoulder, length: 25 }, features: parseFeatures(lines).features },
    session.model,
  )!.solids[0];
  const m = await session.compare(key("Printable nose cone"), stlOf(real, "nose"), "nose.stl");
  assert.deepEqual(m.changes.map((c) => [c.field, c.from, c.to]), [["aftshoulderlength", "20 mm", "25 mm"]]);
  // "@auto off": the real one has no lead-in, so ork-cad mustn't add its own.
  assert.deepEqual(m.added, [lines, "@auto off"]);
  assert.deepEqual(m.check.differences, []);
  assert.match(m.text, /Aft shoulder length: 20 mm → 25 mm/);

  session.applyMatch(key("Printable nose cone"));
  assert.ok(session.hasEdits);
  const views = session.buildAll();
  const now = views.find((v) => v.name === "Printable nose cone")!;
  assert.equal(now.details, `${lines}\n@auto off`);
  assert.deepEqual(now.auto, []);
  assert.ok(Math.abs(now.volume / solidVolume(real) - 1) < 1e-9, `${now.volume} vs ${solidVolume(real)}`);
  const saved = allParts(modelFromBytes(session.saveOrk().bytes)).find((p) => p.name === "Printable nose cone") as TransitionPart;
  assert.ok(Math.abs(saved.aftShoulder.length - 25) < 1e-9 && saved.comment === `${lines}\n@auto off`);
});

test("a tube with a screw joint downloads as its two pieces", async () => {
  const { session, key } = open();
  const tube = key("Paper Body Tube -- DO NOT PRINT");
  const [view] = session.setDetails(tube, "@screw-joint at=60");
  assert.deepEqual(view.errors, []);
  const one = await session.partFile(tube, "stl");
  assert.equal(one.name, "Paper Body Tube -- DO NOT PRINT (2 pieces).zip");
  assert.deepEqual(Object.keys(unzipSync(one.bytes)), [
    "Paper Body Tube -- DO NOT PRINT (fore piece).stl",
    "Paper Body Tube -- DO NOT PRINT (aft piece).stl",
  ]);
  const all = unzipSync((await session.zip()).bytes);
  assert.ok(all["02 Paper Body Tube -- DO NOT PRINT (fore piece).stl"] && all["03 Paper Body Tube -- DO NOT PRINT (aft piece).stl"]);
  assert.match(strFromU8(all["report.txt"]), /03 Paper Body Tube -- DO NOT PRINT \(aft piece\)\.stl {2}\d/);
});

test("canted fins: the spin they give, and printing them on their own", () => {
  // The example with its fins canted 3°.
  const xml = decodeOrkBytes(new Uint8Array(readFileSync(fixture(FILE)))).replace("<cant>0.0</cant>", "<cant>3.0</cant>");
  const session = Session.open(new TextEncoder().encode(xml), FILE, xmlTools);
  const views = session.buildAll();
  const fins = views.find((v) => v.name === "Trapezoidal fin set")!;
  const part = session.part(fins.key);
  assert.ok(part.kind === "finset" && fins.spin);
  // At the fastest top speed among the simulations saved in the file.
  const fastest = session.model.simulations.reduce((a, b) => ((b.maxVelocity ?? 0) > (a.maxVelocity ?? 0) ? b : a));
  assert.equal(fins.spin.simulation, fastest.name);
  assert.equal(fins.spin.speed, fastest.maxVelocity);
  const rate = steadyRoll(part, fastest.maxVelocity!, fastest.maxMach);
  assert.ok(Math.abs(fins.spin.revs - revsPerSecond(rate)) < 1e-12 && Math.abs(fins.spin.load - spinLoad(rate)) < 1e-12);
  assert.equal(fins.spin.cantDegrees, 3);

  // Printed on their own: the fins get their shape back, and the fin can loses them.
  const can = views.find((v) => v.name === "Printable Fin Can and Motor Mount")!;
  const rebuilt = session.setDetails(fins.key, "@auto one-piece=off");
  const separate = rebuilt.find((v) => v.key === fins.key)!;
  const canNow = rebuilt.find((v) => v.key === can.key)!;
  assert.ok(separate.mesh && separate.volume > 0);
  assert.ok(canNow && canNow.volume < can.volume - separate.volume * 0.99, "the fin can is rebuilt without them");
});
