// The page: open or drop an .ork, see the parts in 3D, edit a part's details, compare a part with
// a CAD file of the real thing, and download.
// All the CAD work happens in worker.ts.

import { Viewer } from "./viewer.ts";
import { kindsFor, showForm } from "./detail-form.ts";
import { partColor } from "../src/export/colors.ts";
import type { Message, RequestBody } from "./protocol.ts";
import type { MatchView, PartView, SpacesView, SpinView } from "./session.ts";

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
    p.about.label.split(":")[0],
    p.copies > 1 ? `${p.copies} copies` : "",
    p.printedWith ? `in ${p.printedWith}` : `${(p.volume / 1000).toFixed(1)} cm³`,
    p.printedWith ? "" : massText(p),
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
// The selected part: what it is, its details in words (shown in 3D, changed with a form or as
// text), and downloads

const HELP = `@side-holes count=4 diameter=2 at=10
@end-holes count=4 diameter=3 radius=12 end=fore
@pocket size=24x18 depth=40 corner=4 end=fore round=3
@nut-trap size=M5 depth=12 end=aft angle=90
@chamfer end=aft length=6 angle=30 round=3
@round end=fore radius=3
@solid
@screw-joint at=105 from=aft
@one-piece
@auto vents=off`;

/** What turning each kind of automatic detail off means, for the button's tooltip. */
const AUTO_NAMES: Record<string, string> = {
  solid: "printing solid (it stays hollow, as in OpenRocket)",
  vents: "altimeter vents",
  pocket: "altimeter pocket",
  "nut-trap": "eyebolt nut trap",
  edges: "lead-ins and rounded rims on the shoulders",
  "one-piece": "printing the fins as part of their tube (they get their own STL)",
};

/** The detail shown in 3D: its part and place among the part's details. */
let shownDetail: { key: string; index: number } | null = null;

function hideDetail(): void {
  shownDetail = null;
  viewer.showDetail(null);
}

function showSelected(): void {
  const p = selected ? parts.get(selected) : undefined;
  if (shownDetail && shownDetail.key !== selected) hideDetail();
  if (!p) {
    selectedEl.className = "muted";
    selectedEl.textContent = parts.size ? "Click a part (in the list or the 3D view) to see it here." : "";
    return;
  }
  selectedEl.className = "";
  selectedEl.innerHTML = `
    <h2></h2>
    <p class="part-label"></p>
    <p class="muted part-about"></p>
    <dl>
      <dt>Where</dt><dd data-f="where"></dd>
      <dt>Material</dt><dd data-f="material"></dd>
      <dt>Plastic</dt><dd data-f="volume"></dd>
    </dl>
    <ul class="messages"></ul>
    <section class="spin" hidden>
      <h3>Spin from fin cant</h3>
      <p></p>
    </section>
    <section class="details-section">
      <h3>Details</h3>
      <p class="muted small">Holes, pockets, nuts and other things OpenRocket can't draw. <em>Show in 3D</em> marks what
      a detail cuts away in red, and what it adds in green.</p>
      <ul class="detail-list"></ul>
      <div class="row add-row"><button id="add-detail">+ Add a detail</button></div>
      <div class="detail-form" hidden></div>
      <details class="as-text">
        <summary>Edit the details as text</summary>
        <textarea id="details" rows="6" spellcheck="false" placeholder="@side-holes count=4 diameter=2 at=10"></textarea>
        <div class="row">
          <button id="apply" class="primary">Apply</button>
          <span class="muted">Ctrl+Enter</span>
        </div>
        <div class="help">
          <pre></pre>
          <p>Lengths are mm unless you write <code>in</code> or <code>cm</code> (e.g. <code>1/8in</code>). Angles are degrees, and
          <code>angle=0</code> lines up with the first fin. <code>at</code> is measured from the fore (top) end of the part's body;
          a negative <code>at</code> goes into its fore shoulder. A line here replaces the automatic detail of the same kind;
          <code>@auto off</code> turns them all off for this part, or one kind at a time: <code>@auto vents=off</code>,
          <code>solid=off</code>, <code>pocket=off</code>, <code>nut-trap=off</code>, <code>edges=off</code>,
          <code>one-piece=off</code>. The details are saved into the part's comment when you save the .ork.</p>
        </div>
      </details>
    </section>
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
  selectedEl.querySelector(".part-label")!.textContent = p.about.label + (p.copies > 1 && p.type !== "railbutton" && !p.type.endsWith("finset") ? ` (${p.copies} of them)` : "");
  selectedEl.querySelector(".part-about")!.textContent = p.about.about;
  const field = (f: string) => selectedEl.querySelector<HTMLElement>(`[data-f="${f}"]`)!;
  field("where").textContent = `${p.about.from.toFixed(0)} to ${p.about.to.toFixed(0)} mm from the nose tip`;
  field("material").textContent = p.material || "—";
  field("volume").textContent = p.printedWith
    ? `printed as part of ${p.printedWith}, so it's counted there`
    : `${(p.volume / 1000).toFixed(2)} cm³` +
      (p.density ? ` = ${massText(p)} at ${p.density} kg/m³` : "") +
      (p.massOverride !== undefined ? ` (OpenRocket mass override: ${p.massOverride.toFixed(1)} g)` : "");
  const messages = selectedEl.querySelector(".messages")!;
  for (const [text, cls] of [...p.errors.map((t) => [t, "error"]), ...p.warnings.map((t) => [t, "warn"])]) {
    const li = document.createElement("li");
    li.className = cls;
    li.textContent = text;
    messages.append(li);
  }
  if (p.spin) showSpin(p.spin);
  selectedEl.querySelector("pre")!.textContent = HELP;

  const box = selectedEl.querySelector<HTMLTextAreaElement>("#details")!;
  box.value = p.details;
  const apply = selectedEl.querySelector<HTMLButtonElement>("#apply")!;
  const run = async () => {
    apply.disabled = true;
    hideDetail();
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
  /** The detail lines in the text box, changed and applied. */
  const setLines = (change: (lines: string[]) => string[]) => {
    box.value = change(box.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)).join("\n");
    void run();
  };
  const form = selectedEl.querySelector<HTMLElement>(".detail-form")!;
  const addButton = selectedEl.querySelector<HTMLButtonElement>("#add-detail")!;
  const openForm = (line: string | undefined, done: (line: string) => void) => {
    addButton.hidden = true;
    showForm(form, p.type, line, done, () => (addButton.hidden = false));
    form.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  addButton.hidden = kindsFor(p.type).length === 0;
  addButton.addEventListener("click", () => openForm(undefined, (line) => setLines((lines) => [...lines, line])));
  showDetails(p, openForm, setLines);

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

/** Canted fins: how fast they spin the rocket, and what that does to the eggs. */
function showSpin(s: SpinView): void {
  const section = selectedEl.querySelector<HTMLElement>(".spin")!;
  section.hidden = false;
  const at = s.simulation
    ? `at ${s.speed.toFixed(0)} m/s, the top speed of the simulation "${s.simulation}" when OpenRocket last ran it`
    : `at ${s.speed.toFixed(0)} m/s (no simulation with results is saved in this file)`;
  section.querySelector("p")!.textContent =
    `Canted ${Math.abs(s.cantDegrees).toFixed(1)}°: the rocket spins at ${s.revs.toFixed(1)} turns a second ${at}, ` +
    `which pushes the side of an egg (${s.eggRadius} mm from the axis) outward with ${s.load.toFixed(1)} g. ` +
    `The spin goes with the speed: ${s.revsPer10.toFixed(1)} turns a second for every 10 m/s. (OpenRocket's own roll formulas; ` +
    `its simulations agree to within 2%.) Cant hardly changes the apogee: once the rocket spins, each fin meets the air ` +
    `almost straight on, so it adds next to no drag. To set the apogee, change the nose weight.`;
}

/**
 * The part's details, each in words: the ones written for it (to show in 3D, change with the form,
 * or remove) and the automatic ones (to show, change, or turn off), with why each is there.
 */
function showDetails(
  p: PartView,
  openForm: (line: string | undefined, done: (line: string) => void) => void,
  setLines: (change: (lines: string[]) => string[]) => void,
): void {
  const list = selectedEl.querySelector<HTMLUListElement>(".detail-list")!;
  const button = (text: string, title: string, click: (b: HTMLButtonElement) => void) => {
    const b = document.createElement("button");
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", () => click(b));
    return b;
  };
  const item = (title: string, text: string, line: string, automatic: boolean) => {
    const li = document.createElement("li");
    li.className = automatic ? "detail auto" : "detail";
    const head = document.createElement("div");
    head.className = "detail-head";
    const strong = document.createElement("strong");
    strong.textContent = title;
    head.append(strong);
    if (automatic) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "automatic";
      tag.title = "ork-cad added this by itself, from what's in the design";
      head.append(tag);
    }
    const words = document.createElement("p");
    words.textContent = text;
    const code = document.createElement("code");
    code.className = "detail-line";
    code.textContent = line;
    const buttons = document.createElement("div");
    buttons.className = "detail-buttons";
    li.append(head, words, buttons, code);
    list.append(li);
    return { li, buttons };
  };
  const show3d = (index: number) =>
    button("Show in 3D", "Mark what this detail cuts away (red) and adds (green) on the part", async (b) => {
      if (shownDetail?.key === p.key && shownDetail.index === index) {
        hideDetail();
        b.textContent = "Show in 3D";
        return;
      }
      for (const other of list.querySelectorAll<HTMLButtonElement>("button.showing")) {
        other.classList.remove("showing");
        other.textContent = "Show in 3D";
      }
      b.disabled = true;
      const reply = await request({ type: "detailShape", key: p.key, index });
      b.disabled = false;
      if (reply.type === "error") return setStatus(reply.message, true);
      if (reply.type !== "detailShape") return;
      if (!reply.shape.removed && !reply.shape.added) return setStatus("This detail doesn't change the part's shape.");
      shownDetail = { key: p.key, index };
      viewer.showDetail(reply.shape);
      b.classList.add("showing");
      b.textContent = "Hide";
      setStatus(
        reply.shape.removed && reply.shape.added
          ? "Red: plastic this detail cuts away. Green: plastic it adds."
          : reply.shape.removed
            ? "Red: the plastic this detail cuts away."
            : "Green: the plastic this detail adds.",
      );
    });

  p.written.forEach((d, i) => {
    if (d.title === undefined) {
      const { buttons } = item("Can't be read", "This line has a problem (see above); fix it with Edit, or remove it.", d.line, false);
      buttons.append(
        button("Edit", "Change it as text", () => {
          const text = selectedEl.querySelector<HTMLDetailsElement>(".as-text")!;
          text.open = true;
          selectedEl.querySelector<HTMLTextAreaElement>("#details")!.focus();
        }),
        button("Remove", "Take this line out", () => setLines((lines) => lines.filter((_, k) => k !== i))),
      );
      return;
    }
    const { buttons } = item(d.title, d.text ?? "", d.line, false);
    if (d.index !== undefined) buttons.append(show3d(d.index));
    if (!/^@auto\b/i.test(d.line)) {
      buttons.append(button("Change", "Change it with the form", () => openForm(d.line, (line) => setLines((lines) => lines.map((l, k) => (k === i ? line : l))))));
    }
    buttons.append(button("Remove", "Take this detail out", () => setLines((lines) => lines.filter((_, k) => k !== i))));
  });
  for (const a of p.auto) {
    const { li, buttons } = item(a.title, a.text, a.line, true);
    buttons.append(
      show3d(a.index),
      button("Change", "Your own line takes the place of the automatic one", () => openForm(a.line, (line) => setLines((lines) => [...lines, line]))),
      button("Turn off", `Adds "@auto ${a.kind}=off": no automatic ${AUTO_NAMES[a.kind]} on this part`, () =>
        setLines((lines) => {
          const i = lines.findIndex((l) => /^@auto\b/i.test(l));
          if (i >= 0) return lines.map((l, k) => (k === i ? `${l} ${a.kind}=off` : l));
          return [...lines, `@auto ${a.kind}=off`];
        }),
      ),
    );
    const why = document.createElement("details");
    why.innerHTML = "<summary>Why</summary><p></p>";
    why.querySelector("p")!.textContent = a.why;
    li.insertBefore(why, li.querySelector(".detail-line"));
  }
  for (const text of p.autoNotes) {
    const li = document.createElement("li");
    li.className = "note";
    li.textContent = text;
    list.append(li);
  }
  if (!list.children.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "None yet.";
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
