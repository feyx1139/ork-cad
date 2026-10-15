// Finding the setting for a target apogee (src/flight/solve.ts), with made-up flights in place of
// OpenRocket's (scripts/flight.ts runs it with real ones).

import { test } from "node:test";
import assert from "node:assert/strict";
import { solve } from "../src/flight/solve.ts";

test("nose weight for a target: a few tries, to the tolerance", async () => {
  // Apogee falling with mass, a little curved, like a real rocket's: 300 m with no weight.
  const apogee = async (g: number) => 300 - 0.5 * g + 0.0004 * g * g;
  const r = await solve(apogee, 250, { x0: 143, step: 10, lo: 0, hi: 5000, tolerance: 0.05 });
  assert.ok(r.reached);
  assert.ok(Math.abs(r.y - 250) <= 0.05 && Math.abs((await apogee(r.x)) - r.y) < 1e-12);
  assert.ok(r.tries.length <= 6, `${r.tries.length} tries`);
});

test("a target out of reach: the nearest end of the range, and not reached", async () => {
  // Cant in OpenRocket barely moves the apogee: 243.6 m at 0°, rising 0.06 m a degree.
  const apogee = async (deg: number) => 243.6 + 0.06 * deg;
  const low = await solve(apogee, 240, { x0: 0, step: 5, lo: 0, hi: 15, tolerance: 0.05 });
  assert.ok(!low.reached && low.x === 0);
  const high = await solve(apogee, 260, { x0: 0, step: 5, lo: 0, hi: 15, tolerance: 0.05 });
  assert.ok(!high.reached && high.x === 15);
  assert.ok(low.tries.every((t) => t.x >= 0 && t.x <= 15) && high.tries.every((t) => t.x >= 0 && t.x <= 15));
});

test("a bumpy response: once the target is bracketed, it stays bracketed", async () => {
  // A step-like curve, where secant steps alone overshoot.
  const apogee = async (x: number) => 250 - 20 * Math.tanh((x - 7) * 3);
  const r = await solve(apogee, 251, { x0: 0, step: 1, lo: 0, hi: 15, tolerance: 0.01 });
  assert.ok(r.reached && Math.abs(r.y - 251) <= 0.01, JSON.stringify(r.tries));
});
