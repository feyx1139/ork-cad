// The spin of canted fins (src/aero/roll.ts) against OpenRocket 24.12's own simulations of its
// example rockets with the fins canted 3°: the fastest spin before apogee, and the speed then
// (tools/openrocket-ref/Flight.java, "run sim=0 cant=...:3").

import { test } from "node:test";
import assert from "node:assert/strict";
import { allParts, type FinSetPart } from "../src/ork/model.ts";
import { revsPerSecond, spinLoad, steadyRoll } from "../src/aero/roll.ts";
import { loadOrkFile } from "../src/node/load.ts";
import { fixture } from "./helpers.ts";

const DEG = Math.PI / 180;

async function fins(rocket: string): Promise<FinSetPart> {
  const model = await loadOrkFile(fixture(`${rocket}.ork`));
  return allParts(model).find((p): p is FinSetPart => p.kind === "finset")!;
}

test("canted fins spin the rocket as fast as in OpenRocket's simulation", async () => {
  // OpenRocket's spin lags a little behind the steady one while the rocket speeds up, so they
  // agree to within 2%.
  for (const [rocket, speed, simulated] of [
    ["arc-payload-rocket", 150.252928, 76.28941504],
    ["3d-printable-nose-cone-and-fins", 24.54539458, 14.0499794],
  ] as const) {
    const p = { ...(await fins(rocket)), cant: 3 * DEG };
    const rate = steadyRoll(p, speed);
    assert.ok(Math.abs(rate / simulated - 1) < 0.02, `${rocket}: ${rate} rad/s, OpenRocket ${simulated}`);
  }
});

test("the spin: in step with the speed and the cant, turning with the cant's sign", async () => {
  const p = await fins("3d-printable-nose-cone-and-fins");
  const at = (cant: number, speed: number) => steadyRoll({ ...p, cant: cant * DEG }, speed, 0.1);
  assert.equal(at(0, 50), 0);
  assert.ok(Math.abs(at(2, 60) / at(2, 30) - 2) < 1e-9);
  assert.ok(Math.abs(at(4, 30) / at(2, 30) - 2) < 1e-9);
  assert.ok(Math.abs(at(-2, 30) + at(2, 30)) < 1e-9);
  // 2π rad/s is one turn a second; at 22 mm from the axis that pushes with 4π² × 0.022 m/s².
  assert.equal(revsPerSecond(-2 * Math.PI), 1);
  assert.ok(Math.abs(spinLoad(2 * Math.PI) - (4 * Math.PI ** 2 * 0.022) / 9.80665) < 1e-12);
});
