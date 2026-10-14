// Writing a comment into an .ork changes that comment and nothing else, and OpenRocket still
// opens the file (that last check runs only where OpenRocket is installed).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allParts } from "../src/ork/model.ts";
import { setComment } from "../src/ork/write.ts";
import { modelFromBytes, xmlTools } from "../src/node/load.ts";
import { fixture, readReference, type Reference } from "./helpers.ts";

const ROCKET = "3d-printable-nose-cone-and-fins";
const LINE = "@side-holes count=3 diameter=2 at=60 angle=45";

function edited() {
  const bytes = new Uint8Array(readFileSync(fixture(`${ROCKET}.ork`)));
  const before = modelFromBytes(bytes);
  const nose = allParts(before).find((p) => p.name === "Printable nose cone")!;
  const ring = allParts(before).find((p) => p.name === "Centering ring")!;
  assert.equal(nose.comment, "");
  assert.ok(ring.comment.length > 0);
  let out = setComment(bytes, nose.id, LINE, xmlTools); // adds a <comment> element
  out = setComment(out, ring.id, `${ring.comment}\ndrill by hand`, xmlTools); // extends an existing one
  return { before, out, noseId: nose.id, ringId: ring.id, ringComment: ring.comment };
}

test("setComment changes only the comments asked for", () => {
  const { before, out, noseId, ringId, ringComment } = edited();
  const after = modelFromBytes(out);
  const was = new Map(allParts(before).map((p) => [p.id, p]));
  for (const p of allParts(after)) {
    const q = was.get(p.id)!;
    assert.deepEqual(p.instances, q.instances, p.name);
    assert.equal(p.length, q.length, p.name);
    if (p.id === noseId) {
      assert.equal(p.comment, LINE);
      assert.equal(p.features.length, 1);
    } else if (p.id === ringId) {
      assert.equal(p.comment, `${ringComment}\ndrill by hand`);
    } else {
      assert.equal(p.comment, q.comment, p.name);
    }
  }
});

const home = process.env.OPENROCKET_HOME ?? "C:\\Program Files\\OpenRocket";
const haveOpenRocket = existsSync(path.join(home, "jre"));

test("OpenRocket opens the edited file and reads the comments back", { skip: !haveOpenRocket && "OpenRocket isn't installed" }, async () => {
  const { out, noseId } = edited();
  const dir = mkdtempSync(path.join(tmpdir(), "ork-cad-"));
  try {
    const file = path.join(dir, "edited.ork");
    writeFileSync(file, out);
    execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/make-reference.ts", import.meta.url)), file], {
      stdio: "ignore",
    });
    const reread = JSON.parse(readFileSync(path.join(dir, "edited.openrocket.json"), "utf8")) as Reference;
    const original = await readReference(ROCKET);
    assert.equal(reread.components.length, original.components.length);
    for (const [i, c] of reread.components.entries()) {
      const o = original.components[i];
      assert.deepEqual(c.locations, o.locations, c.name);
      assert.equal(c.componentMass, o.componentMass, c.name);
      if (c.id === noseId) assert.equal(c.comment, LINE);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
