// Flies a design in OpenRocket's own simulator to tune it: the nose weight (or fin cant) that
// gives a target apogee, and how fast canted fins spin the rocket. Needs OpenRocket installed
// (see src/node/openrocket.ts).
//
//   npm run flight -- my-rocket.ork                          every simulation's apogee, as it is now
//   npm run flight -- my-rocket.ork --target 250             the nose weight for 250 m (also 820ft)
//   npm run flight -- my-rocket.ork --target 250 --write tuned.ork
//   npm run flight -- my-rocket.ork --cant 0,1,2,5           apogee and spin at each cant angle
//   npm run flight -- my-rocket.ork --target 250 --cant      the cant angle for 250 m, if any
//
// --sim picks the simulation (its number in OpenRocket's list, or part of its name; default the
// first). --mass names the mass component to change (default: the one called ballast or weight).
// --egg sets how far the side of an egg is from the axis, for the spin's push on it (default 22 mm).

import { readFile, writeFile } from "node:fs/promises";
import { allParts } from "../src/ork/model.ts";
import { setFields } from "../src/ork/write.ts";
import { loadOrkFile, xmlTools } from "../src/node/load.ts";
import { OpenRocketFlights, type DesignInfo, type FlightResult } from "../src/node/openrocket.ts";
import { solve } from "../src/flight/solve.ts";
import { EGG_RADIUS, revsPerSecond, spinLoad } from "../src/aero/roll.ts";
import { parseLength } from "../src/features/parse.ts";

const USAGE = `usage: npm run flight -- <rocket.ork> [--target <apogee, e.g. 250 or 820ft>] [--cant [0,1,2,5]]
       [--sim <number or name>] [--mass <mass component>] [--egg <mm>] [--write <new.ork>]`;

const args = process.argv.slice(2);
const options = new Map<string, string | true>();
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    const next = args[i + 1];
    options.set(a.slice(2), next !== undefined && !next.startsWith("--") ? (i++, next) : true);
  } else {
    positional.push(a);
  }
}
const known = new Set(["target", "cant", "sim", "mass", "egg", "write"]);
const unknown = [...options.keys()].filter((k) => !known.has(k));
if (positional.length !== 1 || unknown.length) {
  console.error(unknown.length ? `unknown option --${unknown[0]}\n${USAGE}` : USAGE);
  process.exit(2);
}
const input = positional[0];
const text = (key: string) => {
  const v = options.get(key);
  if (v === true) fail(`--${key} needs a value`);
  return v;
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** "250", "250m", "820ft" -> metres. */
function metres(value: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(m|ft|feet)?$/i.exec(value.trim());
  if (!m) fail(`--target "${value}" isn't a height (try 250 or 820ft)`);
  return Number(m[1]) * (/^f/i.test(m[2] ?? "") ? 0.3048 : 1);
}

const CANT_NOTE =
  `Cant hardly changes the apogee: once the rocket spins, each fin meets the air almost straight on, so it adds next to\n` +
  `no drag, and the energy that goes into the spin is a fraction of a percent of the flight's. OpenRocket leaves out the\n` +
  `little extra drag of the twisted airflow along the fins, so with cant the real apogee may be a little lower than\n` +
  `these. Spin also evens out small differences between the fins and in the motor's thrust. To set the apogee, change\n` +
  `the nose weight.`;

const ft = (m: number) => (m / 0.3048).toFixed(0);
const height = (m: number) => `${m.toFixed(1)} m (${ft(m)} ft)`;
const eggRadius = options.has("egg") ? parseLength(text("egg")!) : EGG_RADIUS;

const model = await loadOrkFile(input);
const flights = new OpenRocketFlights(input);
try {
  const info = await flights.info();
  if (!info.simulations.length) fail(`${input} has no simulations; add one in OpenRocket (with the motor) first.`);
  const sim = pickSimulation(info);
  const simName = `"${info.simulations[sim].name}" (${info.simulations[sim].motors})`;
  const cantOption = options.get("cant");
  const target = options.has("target") ? metres(text("target")!) : undefined;

  if (target !== undefined && cantOption !== undefined) {
    await cantForTarget(info, sim, simName, target);
  } else if (target !== undefined) {
    await massForTarget(info, sim, simName, target);
  } else if (cantOption !== undefined) {
    const list = cantOption === true ? [0, 1, 2, 3, 5, 10] : cantOption.split(",").map(Number);
    if (list.some((c) => !Number.isFinite(c) || Math.abs(c) > 15)) fail("--cant takes angles in degrees, up to 15 (OpenRocket's limit), e.g. 0,1,2,5");
    await cantTable(info, sim, simName, list);
  } else {
    await summary(info);
  }
} finally {
  flights.close();
}

function pickSimulation(info: DesignInfo): number {
  const want = options.get("sim");
  if (want === undefined) return 0;
  if (want === true) fail("--sim needs a number or part of a simulation's name");
  if (/^\d+$/.test(want)) {
    const n = Number(want);
    if (n < 1 || n > info.simulations.length) fail(`there are ${info.simulations.length} simulations; --sim takes 1 to ${info.simulations.length}`);
    return n - 1;
  }
  const found = info.simulations.flatMap((s, i) => (s.name.toLowerCase().includes(want.toLowerCase()) ? [i] : []));
  if (found.length !== 1) {
    fail(`${found.length ? "more than one" : "no"} simulation matches "${want}":\n${info.simulations.map((s, i) => `  ${i + 1}. ${s.name}`).join("\n")}`);
  }
  return found[0];
}

async function summary(info: DesignInfo): Promise<void> {
  console.log(`${model.name}, flown in OpenRocket's own simulator:\n`);
  for (const [i, s] of info.simulations.entries()) {
    const f = await flights.fly(i);
    console.log(`  ${i + 1}. ${s.name} (${s.motors}): apogee ${height(f.apogee)}, top speed ${f.maxVelocity.toFixed(1)} m/s, lift-off mass ${(f.launchMass * 1000).toFixed(1)} g`);
  }
  console.log(`\nFor a target apogee: --target 250 (or 820ft). To see what fin cant does: --cant 0,1,2,5.`);
}

/** The mass component to change: named by --mass, or the one called ballast or weight. */
function ballast(info: DesignInfo): { name: string; kg: number } {
  const want = options.get("mass");
  if (want === true) fail("--mass needs a mass component's name");
  const list = info.massComponents.map((m) => `  ${m.name} (${(m.kg * 1000).toFixed(1)} g)`).join("\n");
  const matches = want
    ? info.massComponents.filter((m) => m.name.toLowerCase() === want.toLowerCase())
    : info.massComponents.filter((m) => /ballast|weight/i.test(m.name));
  if (matches.length !== 1) {
    fail(
      want
        ? `no mass component is called "${want}"; there are:\n${list}`
        : `${matches.length ? "more than one" : "no"} mass component is called ballast or weight; say which with --mass "<name>":\n${list}`,
    );
  }
  return matches[0];
}

async function massForTarget(info: DesignInfo, sim: number, simName: string, target: number): Promise<void> {
  const weight = ballast(info);
  const fly = (kg: number) => flights.fly(sim, { mass: { [weight.name]: kg } });
  const now = await fly(weight.kg);
  // Mass in grams for the solver; to 0.05 m of the target.
  const result = await solve(async (g) => (await fly(g / 1000)).apogee, target, {
    x0: weight.kg * 1000,
    step: 10,
    lo: 0,
    hi: 5000,
    tolerance: 0.05,
  });
  console.log(`${model.name}, simulation ${simName}, in OpenRocket's own simulator:\n`);
  console.log(`  now:  ${weight.name} ${(weight.kg * 1000).toFixed(1)} g, apogee ${height(now.apogee)}`);
  if (!result.reached) {
    console.log(
      `\n  ${height(target)} can't be reached by changing ${weight.name}: with ${result.x.toFixed(1)} g it's ${height(result.y)}.` +
        (result.x === 0 ? " Even with none the rocket doesn't go that high: it needs less drag, less mass elsewhere or more motor." : ""),
    );
    return;
  }
  const grams = Math.round(result.x * 10) / 10;
  const tuned = await fly(grams / 1000);
  const slope = (tuned.apogee - now.apogee) / (grams - weight.kg * 1000);
  console.log(`  for ${height(target)}: ${weight.name} ${grams.toFixed(1)} g (${signed(grams - weight.kg * 1000)} g), apogee ${height(tuned.apogee)}`);
  if (Number.isFinite(slope)) console.log(`  Each gram changes the apogee by ${Math.abs(slope).toFixed(2)} m (${Math.abs(slope / 0.3048).toFixed(1)} ft) here.`);
  console.log(`  Lift-off mass ${(tuned.launchMass * 1000).toFixed(1)} g (was ${(now.launchMass * 1000).toFixed(1)} g).`);
  if (info.simulations.length > 1) {
    console.log(`\n  With ${grams.toFixed(1)} g, the other simulations:`);
    for (const [i, s] of info.simulations.entries()) {
      if (i === sim) continue;
      const f = await flights.fly(i, { mass: { [weight.name]: grams / 1000 } });
      console.log(`    ${i + 1}. ${s.name}: ${height(f.apogee)}`);
    }
  }
  await write(`${weight.name} is ${grams.toFixed(1)} g`, (bytes) => {
    const part = allParts(model).filter((p) => p.name === weight.name);
    if (part.length !== 1 || !part[0].id) fail(`can't find ${weight.name} in the file to change it`);
    return setFields(bytes, part[0].id, { mass: String(grams / 1000) }, xmlTools);
  });
}

async function cantTable(info: DesignInfo, sim: number, simName: string, cants: number[]): Promise<void> {
  if (!info.finSets.length) fail("the design has no fins to cant");
  console.log(`${model.name}, simulation ${simName}, in OpenRocket's own simulator, every fin set canted:\n`);
  console.log(`  cant   apogee              fastest spin            push on an egg's side (${eggRadius} mm out)`);
  let base: FlightResult | undefined;
  for (const c of cants) {
    const f = await flights.fly(sim, { cant: Object.fromEntries(info.finSets.map((s) => [s.name, c])) });
    base ??= f;
    const spin = `${revsPerSecond(f.maxRollRate).toFixed(1)} turns/s at ${f.velocityAtMaxRoll.toFixed(0)} m/s`;
    const change = f === base ? "" : ` (${signed(f.apogee - base.apogee, 2)} m)`;
    console.log(`  ${c.toFixed(1).padStart(4)}°  ${(f.apogee.toFixed(1) + " m" + change).padEnd(20)}${spin.padEnd(24)}${spinLoad(f.maxRollRate, eggRadius).toFixed(1)} g`);
  }
  console.log(`\n${CANT_NOTE}`);
}

async function cantForTarget(info: DesignInfo, sim: number, simName: string, target: number): Promise<void> {
  if (!info.finSets.length) fail("the design has no fins to cant");
  const fly = (deg: number) => flights.fly(sim, { cant: Object.fromEntries(info.finSets.map((s) => [s.name, deg])) });
  const result = await solve(async (deg) => (await fly(deg)).apogee, target, { x0: 0, step: 5, lo: 0, hi: 15, tolerance: 0.05 });
  console.log(`${model.name}, simulation ${simName}, in OpenRocket's own simulator:\n`);
  if (!result.reached) {
    const reach = [...result.tries.map((t) => t.y), (await fly(0)).apogee, (await fly(15)).apogee];
    console.log(
      `  No cant from 0° to 15° gives ${height(target)}: the apogee only goes from ${height(Math.min(...reach))} to ${height(Math.max(...reach))}.`,
    );
    console.log(`  Change the nose weight instead: npm run flight -- ${input} --target ${target.toFixed(1)}\n\n${CANT_NOTE}`);
    return;
  }
  const deg = Math.round(result.x * 100) / 100;
  const f = await fly(deg);
  console.log(`  for ${height(target)}: cant ${deg.toFixed(2)}°, apogee ${height(f.apogee)}`);
  console.log(`  The rocket spins at up to ${revsPerSecond(f.maxRollRate).toFixed(1)} turns a second, pushing the side of an egg (${eggRadius} mm out) with ${spinLoad(f.maxRollRate, eggRadius).toFixed(1)} g.`);
  console.log(`\n${CANT_NOTE}`);
  await write(`every fin set is canted ${deg.toFixed(2)}°`, (bytes) => {
    for (const p of allParts(model).filter((q) => q.kind === "finset")) bytes = setFields(bytes, p.id, { cant: String(deg) }, xmlTools);
    return bytes;
  });
}

async function write(what: string, change: (bytes: Uint8Array) => Uint8Array): Promise<void> {
  const out = options.get("write");
  if (out === undefined) {
    console.log(`\n(--write new.ork saves a copy of the design where ${what}.)`);
    return;
  }
  if (out === true) fail("--write needs a file name");
  if (out === input) fail("--write must be a new file, not the design itself");
  await writeFile(out, change(new Uint8Array(await readFile(input))));
  console.log(`\nWrote ${out}, where ${what}.`);
}

function signed(v: number, digits = 1): string {
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}`;
}
