// Runs OpenRocket itself, from Node: its own flight simulations of a design, with nose weight or
// fin cant changed, through tools/openrocket-ref/Flight.java. Needs OpenRocket installed (default
// C:\Program Files\OpenRocket; set OPENROCKET_HOME to the folder holding its jar/ and jre/).

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

export interface OpenRocketInstall {
  java: string;
  jar: string;
  /** Our compiled helpers (RefExport, Flight). */
  classes: string;
}

/** Where OpenRocket is, or a message saying how to tell us. */
export function findOpenRocket(): OpenRocketInstall {
  const home = process.env.OPENROCKET_HOME ?? "C:\\Program Files\\OpenRocket";
  const jarDir = path.join(home, "jar");
  const jar = existsSync(jarDir) ? readdirSync(jarDir).find((f) => /^OpenRocket.*\.jar$/i.test(f)) : undefined;
  const java = path.join(home, "jre", "bin", process.platform === "win32" ? "java.exe" : "java");
  if (!jar || !existsSync(java)) {
    throw new Error(`OpenRocket not found in ${home} (expected jar/OpenRocket-*.jar and jre/). Install it, or set OPENROCKET_HOME.`);
  }
  return { java, jar: path.join(jarDir, jar), classes: fileURLToPath(new URL("../../tools/openrocket-ref/build", import.meta.url)) };
}

export interface SimulationInfo {
  name: string;
  motors: string;
}

export interface DesignInfo {
  simulations: SimulationInfo[];
  massComponents: { name: string; kg: number }[];
  finSets: { name: string; cantDegrees: number; count: number }[];
}

/** One flight as OpenRocket simulates it (SI units: m, m/s, kg, rad/s). */
export interface FlightResult {
  apogee: number;
  maxVelocity: number;
  timeToApogee: number;
  launchMass: number;
  rollInertia: number;
  /** Fastest spin up to apogee, when, and the speed then. */
  maxRollRate: number;
  maxRollTime: number;
  velocityAtMaxRoll: number;
  warnings: string;
}

/** What to change for one run: masses of mass components (kg) and fin sets' cant (degrees), by name. */
export interface FlightChanges {
  mass?: Record<string, number>;
  cant?: Record<string, number>;
}

/**
 * A running OpenRocket with one design loaded (it takes a few seconds to start; each flight then
 * takes a fraction of a second). Each flight uses the simulation's own random seed, so the same
 * changes always give the same flight. Close it when done.
 */
export class OpenRocketFlights {
  private child: ChildProcessWithoutNullStreams;
  private lines: Interface;
  private waiting: ((line: string) => void)[] = [];
  private failed?: Error;

  constructor(ork: string, install = findOpenRocket()) {
    this.child = spawn(install.java, ["-cp", [install.jar, install.classes].join(path.delimiter), "Flight", ork], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    // OpenRocket logs to stdout too; our answers are the lines of JSON.
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      if (line.startsWith("{")) this.waiting.shift()?.(line);
    });
    this.child.stderr.resume();
    this.child.on("exit", (code) => {
      this.failed = new Error(`OpenRocket stopped (exit code ${code}).`);
      for (const w of this.waiting.splice(0)) w(JSON.stringify({ error: this.failed.message }));
    });
  }

  private ask<T>(command: string[]): Promise<T> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.waiting.push((line) => {
        const reply = JSON.parse(line) as T & { error?: string };
        if (reply.error) reject(new Error(`OpenRocket: ${reply.error}`));
        else resolve(reply);
      });
      this.child.stdin.write(command.join("\t") + "\n");
    });
  }

  info(): Promise<DesignInfo> {
    return this.ask(["info"]);
  }

  /** Simulation `sim` (from 0, in the design's order) with these changes. */
  fly(sim: number, changes: FlightChanges = {}): Promise<FlightResult> {
    for (const name of [...Object.keys(changes.mass ?? {}), ...Object.keys(changes.cant ?? {})]) {
      if (/[\t\r\n]/.test(name)) throw new Error(`A component name with a tab or line break can't be changed: ${JSON.stringify(name)}`);
    }
    return this.ask([
      "run",
      `sim=${sim}`,
      ...Object.entries(changes.mass ?? {}).map(([name, kg]) => `mass=${name}:${kg}`),
      ...Object.entries(changes.cant ?? {}).map(([name, deg]) => `cant=${name}:${deg}`),
    ]);
  }

  close(): void {
    this.child.stdin.end();
  }
}
