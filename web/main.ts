// The page: open or drop an .ork, see the parts in 3D, edit a part's details, compare a part with
// a CAD file of the real thing, and download.
// All the CAD work happens in worker.ts.

import { Viewer } from "./viewer.ts";
import { partColor } from "../src/export/colors.ts";
import type { Message, RequestBody } from "./protocol.ts";
import type { MatchView, PartView, SpacesView } from "./session.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $("status");
const partsEl = $<HTMLUListElement>("parts");
const spacesEl = $("spaces");
const selectedEl = $("selected");
const zipButton = $<HTMLButtonElement>("zip");
const onshapeButton = $<HTMLButtonElement>("onshape");
const saveButton = $<HTMLButtonElement>("save");
const welcome = $("welcome");
const toolbar = $("toolbar");

const viewer = new Viewer($("canvas"));
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

const parts = new Map<string, PartView>();
/** The last comparison of each part with a CAD file, and the file (to compare it the other way round). */
const matches = new Map<string, MatchView>();
const cadFiles = new Map<string, { file: File; flip: boolean }>();
const hidden = new Set<string>();
let selected: string | null = null;
let unsaved = false;
let fileName = "";
/** Frame the view on the first part to arrive, before the rest are built. */
let fitPending = false;

// ---------------------------------------------------------------------------------------------
// Talking to the worker

let nextId = 1;
const pending = new Map<number, (m: Message) => void>();

function request(body: RequestBody, transfer: Transferable[] = []): Promise<Message> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ ...body, id }, transfer);
  });
}

worker.onmessage = (e: MessageEvent<Message>) => {
  const m = e.data;
  switch (m.type) {
    case "progress":
      setStatus(m.text);
      break;
    case "rocket":
      fileName = m.rocket.fileName;
      document.title = `${m.rocket.name} · ork-cad`;
      break;
    case "part":
      showPart(m.part);
      break;
    case "spaces":
      showSpaces(m.spaces);
      break;
    default: {
      const resolve = pending.get(m.id);
      pending.delete(m.id);
      resolve?.(m);
    }
  }
};

worker.onerror = (e) => setStatus(`The CAD engine stopped: ${e.message}`, true);

// ---------------------------------------------------------------------------------------------
// Opening a design

async function open(file: File): Promise<void> {
  if (unsaved && !confirm("Your detail changes aren't saved. Open another design anyway?")) return;
  parts.clear();
  matches.clear();
  cadFiles.clear();
  hidden.clear();
  selected = null;
  unsaved = false;
  partsEl.replaceChildren();
  viewer.clear();
  showSelected();
  welcome.hidden = true;
  toolbar.hidden = false;
  zipButton.disabled = onshapeButton.disabled = saveButton.disabled = true;
  const bytes = await file.arrayBuffer();
  fitPending = true;
  const reply = await request({ type: "open", bytes, fileName: file.name }, [bytes]);
  viewer.fit();
  if (reply.type === "error") {
    setStatus(`Couldn't open ${file.name}: ${reply.message}`, true);
    welcome.hidden = false;
    toolbar.hidden = true;
    return;
  }
  zipButton.disabled = onshapeButton.disabled = parts.size === 0;
  showSelected();
  const problems = [...parts.values()].filter((p) => p.errors.length).length;
  setStatus(`${file.name}: ${parts.size} parts${problems ? `, ${problems} with problems in their details` : ""}.`);
}

$<HTMLInputElement>("file").addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  if (input.files?.[0]) void open(input.files[0]);
  input.value = "";
});

const dropOverlay = $("drop");
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropOverlay.hidden = false;
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) dropOverlay.hidden = true;
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dropOverlay.hidden = true;
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => /\.ork$/i.test(f.name));
  if (file) void open(file);
  else setStatus("That isn't an .ork file.", true);
});

window.addEventListener("beforeunload", (e) => {
  if (unsaved) e.preventDefault();
});

// ---------------------------------------------------------------------------------------------
// Parts list and 3D view

/** The same colours the STEP file for Onshape has. */
function colorOf(p: PartView): string {
  return partColor(p.material);
}

function showPart(p: PartView): void {
  parts.set(p.key, p);
  if (p.mesh) viewer.setPart(p.key, p.mesh, colorOf(p));
  else viewer.remove(p.key);
  if (fitPending && p.mesh) {
    fitPending = false;
    viewer.fit();
  }
  let row = partsEl.querySelector<HTMLLIElement>(`li[data-key="${CSS.escape(p.key)}"]`);
  if (!row) {
    row = document.createElement("li");
    row.dataset.key = p.key;
    partsEl.append(row);
  }
  const eye = document.createElement("input");
  eye.type = "checkbox";
  eye.checked = !hidden.has(p.key);
  eye.title = "Show or hide";
  eye.addEventListener("change", () => {
    if (eye.checked) hidden.delete(p.key);
    else hidden.add(p.key);
    viewer.setVisible(p.key, eye.checked);
  });
  const name = document.createElement("button");
  name.className = "part-name";
  name.innerHTML = `<span class="swatch" style="background:${colorOf(p)}"></span><span></span>`;
  (name.lastChild as HTMLElement).textContent = p.name;
  name.addEventListener("click", () => select(p.key));
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = [
    p.copies > 1 ? `${p.copies} copies` : "",
    `${(p.volume / 1000).toFixed(1)} cm³`,
    massText(p),
    p.details ? `${p.details.split("\n").length} detail${p.details.includes("\n") ? "s" : ""}` : "",
    p.auto.length ? `${p.auto.length} automatic` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const badge = document.createElement("span");
  badge.className = p.errors.length ? "badge error" : p.warnings.length ? "badge warn" : "badge";
  badge.textContent = p.errors.length ? "!" : p.warnings.length ? "note" : "";
  row.replaceChildren(eye, name, badge, meta);
  row.classList.toggle("selected", p.key === selected);
  viewer.setVisible(p.key, !hidden.has(p.key));
  if (p.key === selected) showSelected();
}

function massText(p: PartView): string {
  return p.density ? `${(p.volume * 1e-6 * p.density).toFixed(1)} g` : "";
}

function select(key: string | null): void {
  selected = key;
  for (const row of partsEl.children) row.classList.toggle("selected", (row as HTMLElement).dataset.key === key);
  viewer.select(key);
  showSelected();
}

viewer.onPick = (key) => select(key);

$("fit").addEventListener("click", () => viewer.fit());
$<HTMLInputElement>("cut").addEventListener("change", (e) => viewer.setCut((e.target as HTMLInputElement).checked));
$<HTMLInputElement>("only").addEventListener("change", (e) => viewer.setOnlySelected((e.target as HTMLInputElement).checked));

// ---------------------------------------------------------------------------------------------
// The selected part: facts, details editor, downloads

const HELP = `@side-holes count=4 diameter=2 at=10
@end-holes count=4 diameter=3 radius=12 end=fore
@pocket size=24x18 depth=40 corner=4 end=fore round=3
@nut-trap size=M5 depth=12 end=aft angle=90
@chamfer end=aft length=6 angle=30 round=3
@round end=fore radius=3
@solid
@auto vents=off`;

/** What turning each kind of automatic detail off means, for the button's tooltip. */
const AUTO_NAMES: Record<string, string> = {
  solid: "printing solid (it stays hollow, as in OpenRocket)",
  vents: "altimeter vents",
  pocket: "altimeter pocket",
  "nut-trap": "eyebolt nut trap",
  edges: "lead-ins and rounded rims on the shoulders",
};

function showSelected(): void {
  const p = selected ? parts.get(selected) : undefined;
  if (!p) {
    selectedEl.className = "muted";
    selectedEl.textContent = parts.size ? "Click a part (in the list or the 3D view) to see it here." : "";
    return;
  }
  selectedEl.className = "";
  selectedEl.innerHTML = `
    <h2></h2>
    <dl>
      <dt>Type</dt><dd data-f="type"></dd>
      <dt>Material</dt><dd data-f="material"></dd>
      <dt>Plastic</dt><dd data-f="volume"></dd>
    </dl>
    <ul class="messages"></ul>
    <label for="details"><strong>Details</strong> <span class="muted">— holes, pockets, nut traps…</span></label>
    <textarea id="details" rows="6" spellcheck="false" placeholder="@side-holes count=4 diameter=2 at=10"></textarea>
    <div class="row">
      <button id="apply" class="primary">Apply</button>
      <span class="muted">Ctrl+Enter</span>
    </div>
    <section class="auto" hidden>
      <h3>Automatic details</h3>
      <p class="muted">ork-cad adds these by itself, from what's in the design. <em>Edit</em> copies one into the details
      above, where your line takes its place; <em>Turn off</em> adds an <code>@auto</code> line.</p>
      <ul class="auto-list"></ul>
    </section>
    <details class="help">
      <summary>What can I write here?</summary>
      <pre></pre>
      <p>Lengths are mm unless you write <code>in</code> or <code>cm</code> (e.g. <code>1/8in</code>). Angles are degrees, and
      <code>angle=0</code> lines up with the first fin. <code>at</code> is measured from the fore end of the part's body;
      a negative <code>at</code> goes into its fore shoulder. A chamfer can be given by its <code>inset</code> (how far in
      it cuts at the end face) instead of its <code>length</code>, and a pocket's <code>round</code> rounds the edge of its
      mouth. Pockets and nut traps need the part to be solid: tick <em>Filled</em> for it in OpenRocket, or write
      <code>@solid</code> (ork-cad adds it by itself to a part whose material has an infill's density). A line here
      replaces the automatic detail of the same kind; <code>@auto off</code> turns them all off for this part, or one kind
      at a time: <code>@auto vents=off</code>, <code>solid=off</code>, <code>pocket=off</code>, <code>nut-trap=off</code>,
      <code>edges=off</code>.
      The details are saved into the part's comment when you save the .ork.</p>
    </details>
    <h3>Download this part</h3>
    <div class="row">
      <button data-format="stl" class="primary">STL (for printing)</button>
      <button data-format="step" title="Exact curved surfaces, every copy in its place on the rocket">STEP (to edit in Onshape)</button>
    </div>
    <section class="compare" hidden>
      <h3>Compare with your CAD file</h3>
      <p class="muted">Made this part in Onshape or another CAD program? Export it as STEP or STL (in Onshape:
      right-click the part, Export) and pick the file. ork-cad works out what to change in the design so it
      makes that part, and checks the result.</p>
      <div class="row">
        <label class="button" for="cad">Choose a STEP or STL file…</label>
        <input id="cad" type="file" accept=".step,.stp,.stl" hidden />
      </div>
      <div class="match"></div>
    </section>`;
  selectedEl.querySelector("h2")!.textContent = p.name;
  const field = (f: string) => selectedEl.querySelector<HTMLElement>(`[data-f="${f}"]`)!;
  field("type").textContent = `${p.type}${p.copies > 1 ? `, ${p.copies} copies` : ""}`;
  field("material").textContent = p.material || "—";
  field("volume").textContent =
    `${(p.volume / 1000).toFixed(2)} cm³` +
    (p.density ? ` = ${massText(p)} at ${p.density} kg/m³` : "") +
    (p.massOverride !== undefined ? ` (OpenRocket mass override: ${p.massOverride.toFixed(1)} g)` : "");
  const messages = selectedEl.querySelector(".messages")!;
  for (const [text, cls] of [...p.errors.map((t) => [t, "error"]), ...p.warnings.map((t) => [t, "warn"])]) {
    const li = document.createElement("li");
    li.className = cls;
    li.textContent = text;
    messages.append(li);
  }
  selectedEl.querySelector("pre")!.textContent = HELP;
  const box = selectedEl.querySelector<HTMLTextAreaElement>("#details")!;
  box.value = p.details;
  const apply = selectedEl.querySelector<HTMLButtonElement>("#apply")!;
  const run = async () => {
    apply.disabled = true;
    setStatus(`Rebuilding ${p.name}…`);
    const reply = await request({ type: "setDetails", key: p.key, details: box.value });
    apply.disabled = false;
    if (reply.type === "error") return setStatus(reply.message, true);
    unsaved = true;
    saveButton.disabled = false;
    const now = parts.get(p.key)!;
    setStatus(now.errors.length ? `${p.name}: see the problems listed with the part.` : `${p.name} rebuilt with its details.`, now.errors.length > 0);
  };
  apply.addEventListener("click", run);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void run();
  });
  showAuto(p, box, run);
  for (const b of selectedEl.querySelectorAll<HTMLButtonElement>("button[data-format]")) {
    b.disabled = !p.mesh;
    b.addEventListener("click", () => void download({ type: "file", key: p.key, format: b.dataset.format as "stl" | "step" }, b));
  }
  selectedEl.querySelector<HTMLElement>(".compare")!.hidden = !p.mesh || (p.type !== "nosecone" && p.type !== "transition");
  const cad = selectedEl.querySelector<HTMLInputElement>("#cad")!;
  cad.addEventListener("change", () => {
    const file = cad.files?.[0];
    cad.value = "";
    if (file) void compare(p, file);
  });
  const shown = matches.get(p.key);
  if (shown) showMatch(shown);
}

/** The selected part's automatic details: each with why it's there, to edit or turn off. */
function showAuto(p: PartView, box: HTMLTextAreaElement, apply: () => Promise<void>): void {
  const section = selectedEl.querySelector<HTMLElement>(".auto")!;
  const list = section.querySelector("ul")!;
  section.hidden = !p.auto.length && !p.autoNotes.length && !p.autoOff.length;
  for (const a of p.auto) {
    const li = document.createElement("li");
    const line = document.createElement("code");
    line.textContent = a.line;
    const edit = document.createElement("button");
    edit.textContent = "Edit";
    edit.title = "Copy it into the details above to change it; your line takes its place";
    edit.addEventListener("click", () => {
      box.value = [box.value.trim(), a.line].filter(Boolean).join("\n");
      box.focus();
      setStatus("Change the line as you like, then Apply: it takes the place of the automatic one.");
    });
    const off = document.createElement("button");
    off.textContent = "Turn off";
    off.title = `Adds "@auto ${a.kind}=off": no automatic ${AUTO_NAMES[a.kind]} on this part`;
    off.addEventListener("click", () => {
      const lines = box.value.split(/\r?\n/).filter((l) => l.trim());
      const i = lines.findIndex((l) => /^\s*@auto\b/i.test(l));
      if (i >= 0) lines[i] = `${lines[i].trimEnd()} ${a.kind}=off`;
      else lines.push(`@auto ${a.kind}=off`);
      box.value = lines.join("\n");
      void apply();
    });
    const buttons = document.createElement("span");
    buttons.className = "auto-buttons";
    buttons.append(edit, off);
    const why = document.createElement("details");
    why.innerHTML = "<summary>Why</summary><p></p>";
    why.querySelector("p")!.textContent = a.why;
    li.append(line, buttons, why);
    list.append(li);
  }
  for (const text of p.autoNotes) {
    const li = document.createElement("li");
    li.className = "note";
    li.textContent = text;
    list.append(li);
  }
  if (p.autoOff.length) {
    const li = document.createElement("li");
    li.className = "note";
    li.textContent = `Turned off for this part by the @auto line in its details: ${p.autoOff.map((k) => AUTO_NAMES[k]).join(", ")}.`;
    list.append(li);
  }
}

// ---------------------------------------------------------------------------------------------
// Comparing a part with a CAD file

async function compare(p: PartView, file: File, flip = false): Promise<void> {
  setStatus(`Comparing ${p.name} with ${file.name}…`);
  cadFiles.set(p.key, { file, flip });
  const bytes = await file.arrayBuffer();
  const reply = await request({ type: "compare", key: p.key, bytes, fileName: file.name, flip }, [bytes]);
  if (reply.type === "error") return setStatus(`Couldn't compare ${p.name} with ${file.name}: ${reply.message}`, true);
  if (reply.type !== "match") return;
  const m = reply.match;
  matches.set(p.key, m);
  if (selected === p.key) showMatch(m);
  const count = m.changes.length + m.added.length + m.removed.length;
  setStatus(count ? `${p.name}: ${count} change${count > 1 ? "s" : ""} to make it match ${file.name}.` : `${p.name} already matches ${file.name}.`);
}

function showMatch(m: MatchView): void {
  const box = selectedEl.querySelector<HTMLElement>(".match");
  if (!box) return;
  box.replaceChildren();
  const add = (tag: string, text: string, cls = "") => {
    const el = document.createElement(tag);
    el.textContent = text;
    if (cls) el.className = cls;
    box.append(el);
    return el;
  };
  const list = (items: string[], cls = "") => {
    const ul = document.createElement("ul");
    if (cls) ul.className = "messages";
    for (const text of items) {
      const li = document.createElement("li");
      li.textContent = text;
      if (cls) li.className = cls;
      ul.append(li);
    }
    box.append(ul);
  };
  add("p", `Compared with ${m.file}:`, "muted");
  if (m.changes.length) {
    add("h4", "Change in OpenRocket");
    list(m.changes.map((c) => `${c.label}: ${c.from} → ${c.to}`));
  }
  if (m.added.length) {
    add("h4", "Detail lines to add");
    add("pre", m.added.join("\n"));
  }
  if (m.removed.length) {
    add("h4", "Detail lines to take out");
    add("pre", m.removed.join("\n"));
  }
  const count = m.changes.length + m.added.length + m.removed.length;
  if (!count) add("p", "Nothing to change.");
  if (m.notes.length) list(m.notes, "note");
  const c = m.check;
  const volumes = `${(c.fileVolume / 1000).toFixed(2)} cm³ in the file, ${(c.builtVolume / 1000).toFixed(2)} cm³ built`;
  if (c.differences.length) {
    add("p", `With ${count ? "these changes" : "the design as it is"}, it still differs from the file (${volumes}):`, "warn");
    list(c.differences, "warn");
  } else {
    add("p", `With ${count ? "these changes" : "the design as it is"}, it matches the file: no point of either surface is more than ${c.maxDistance.toFixed(3)} mm from the other (${volumes}).`, "ok");
  }
  const row = document.createElement("div");
  row.className = "row";
  if (count) {
    const b = document.createElement("button");
    b.className = "primary";
    b.textContent = "Make these changes";
    b.addEventListener("click", () => void applyMatch(m, b));
    row.append(b);
  }
  const again = cadFiles.get(m.key);
  const part = parts.get(m.key);
  // A nose cone's tip says which end is which; a transition the same size at both ends doesn't.
  if (again && part && part.type === "transition") {
    const b = document.createElement("button");
    b.textContent = "Compare the other way round";
    b.title = "Take the other end of the file's part as its fore end";
    b.addEventListener("click", () => void compare(part, again.file, !again.flip));
    row.append(b);
  }
  box.append(row);
}

async function applyMatch(m: MatchView, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  setStatus(`Changing ${m.part}…`);
  const reply = await request({ type: "applyMatch", key: m.key });
  if (reply.type === "error") {
    button.disabled = false;
    return setStatus(reply.message, true);
  }
  matches.clear();
  cadFiles.clear();
  unsaved = true;
  saveButton.disabled = false;
  showSelected();
  setStatus(`${m.part} now matches ${m.file}. Save .ork to keep the changes.`);
}

// ---------------------------------------------------------------------------------------------
// Sealed spaces

function showSpaces(s: SpacesView): void {
  spacesEl.className = "";
  spacesEl.replaceChildren();
  const list = document.createElement("ol");
  list.className = "spaces";
  for (const c of s.spaces) {
    const li = document.createElement("li");
    const head = document.createElement("div");
    head.className = "space-head";
    head.textContent = `${c.from.toFixed(0)}–${c.to.toFixed(0)} mm` + (c.volume > 0 ? ` · ${(c.volume / 1000).toFixed(0)} cm³ of air` : "") + (c.openAtTail ? " · open at the tail" : "");
    const what = [...c.contents, ...(c.ejection ? ["ejection charge"] : [])];
    const body = document.createElement("div");
    body.className = "muted";
    body.textContent = `${what.length ? what.join(", ") : "empty"}${c.vents.length ? ` · vents: ${c.vents.join(", ")}` : ""}`;
    li.append(head, body);
    list.append(li);
  }
  spacesEl.append(list);
  for (const [text, cls] of [...s.warnings.map((t) => [t, "warn"]), ...s.notes.map((t) => [t, "note"])]) {
    const p = document.createElement("p");
    p.className = cls;
    p.textContent = text;
    spacesEl.append(p);
  }
}

// ---------------------------------------------------------------------------------------------
// Downloads

/** Asks the worker for a file and saves it; returns whether that worked. */
async function download(body: RequestBody, button: HTMLButtonElement): Promise<boolean> {
  button.disabled = true;
  const reply = await request(body);
  button.disabled = false;
  if (reply.type === "error") {
    setStatus(reply.message, true);
    return false;
  }
  if (reply.type !== "file") return false;
  const url = URL.createObjectURL(new Blob([reply.bytes]));
  const a = document.createElement("a");
  a.href = url;
  a.download = reply.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  setStatus(`Saved ${reply.name}.`);
  return true;
}

zipButton.addEventListener("click", () => void download({ type: "zip" }, zipButton));
onshapeButton.addEventListener("click", async () => {
  if (await download({ type: "rocketStep" }, onshapeButton)) {
    setStatus("Saved the STEP file. In Onshape: Import it, and every part shows up separately, with its name and exact sizes.");
  }
});
saveButton.addEventListener("click", async () => {
  if (!(await download({ type: "save" }, saveButton))) return;
  unsaved = false;
  setStatus(`Saved ${fileName} with your details. It opens in OpenRocket as usual; the details are in each part's comment.`);
});

function setStatus(text: string, problem = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("problem", problem);
}
