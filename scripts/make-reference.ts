// Makes OpenRocket's own reference output for test designs: its OBJ export and the positions,
// lengths, masses and volumes it computes (tools/openrocket-ref/RefExport.java). Writes
// <name>.openrocket.obj and <name>.openrocket.json next to each .ork.
//
//   npm run reference -- test/fixtures/new-design.ork [more .ork files]
//
// Needs OpenRocket installed; it runs with OpenRocket's own Java and jar. Default location is
// C:\Program Files\OpenRocket; set OPENROCKET_HOME for another one (the folder holding jar/ and jre/).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const home = process.env.OPENROCKET_HOME ?? "C:\\Program Files\\OpenRocket";
const jarDir = path.join(home, "jar");
const jar = existsSync(jarDir) ? readdirSync(jarDir).find((f) => /^OpenRocket.*\.jar$/i.test(f)) : undefined;
const java = path.join(home, "jre", "bin", process.platform === "win32" ? "java.exe" : "java");
if (!jar || !existsSync(java)) {
  console.error(`OpenRocket not found in ${home} (expected jar/OpenRocket-*.jar and jre/). Set OPENROCKET_HOME.`);
  process.exit(1);
}
const classes = fileURLToPath(new URL("../tools/openrocket-ref/build", import.meta.url));
const orks = process.argv.slice(2);
if (!orks.length) {
  console.error("usage: npm run reference -- <design.ork> [more .ork files]");
  process.exit(2);
}
for (const ork of orks) {
  const base = ork.replace(/\.ork$/i, "") + ".openrocket";
  const out = execFileSync(java, ["-cp", [path.join(jarDir, jar), classes].join(path.delimiter), "RefExport", ork, base], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  // Show RefExport's own summary, not OpenRocket's log.
  for (const line of out.split(/\r?\n/)) {
    if (line.includes(": rocket length ") || line.startsWith("OpenRocket warnings:")) console.log(line);
  }
}
