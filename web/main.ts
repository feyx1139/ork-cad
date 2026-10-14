// The page: open or drop an .ork, see the parts in 3D, edit a part's details, and download.
// All the CAD work happens in worker.ts.

import { Viewer } from "./viewer.ts";
import type { Message, RequestBody } from "./protocol.ts";
import type { PartView, SpacesView } from "./session.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $("status");
const partsEl = $<HTMLUListElement>("parts");
const spacesEl = $("spaces");
const selectedEl = $("selected");
const zipButton = $<HTMLButtonElement>("zip");
const saveButton = $<HTMLButtonElement>("save");
const welcome = $("welcome");
const toolbar = $("toolbar");

const viewer = new Viewer($("canvas"));
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

const parts = new Map<string, PartView>();
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
  hidden.clear();
  selected = null;
  unsaved = false;
  partsEl.replaceChildren();
  viewer.clear();
  showSelected();
  welcome.hidden = true;
  toolbar.hidden = false;
  zipButton.disabled = saveButton.disabled = true;
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
  zipButton.disabled = parts.size === 0;
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

function colorOf(p: PartView): string {
  if (p.printed) return "#e8833a";
  if (/paper|card|kraft|glassine|fiber/i.test(p.material)) return "#c9a56c";
  return "#9aa4b1";
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
@pocket size=24x18 depth=40 corner=4 end=fore
@nut-trap size=M5 depth=12 end=aft angle=90
@chamfer end=aft length=6 angle=30 round=3
@round end=fore radius=3`;

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
    <textarea id="details" rows="6" spellcheck="false" placeholder="@side-holes count=8 diameter=2 at=5"></textarea>
    <div class="row">
      <button id="apply" class="primary">Apply</button>
      <span class="muted">Ctrl+Enter</span>
    </div>
    <details class="help">
      <summary>What can I write here?</summary>
      <pre></pre>
      <p>Lengths are mm unless you write <code>in</code> or <code>cm</code> (e.g. <code>1/8in</code>). Angles are degrees, and
      <code>angle=0</code> lines up with the first fin. <code>at</code> is measured from the fore end of the part's body;
      a negative <code>at</code> goes into its fore shoulder. Pockets and nut traps need the part to be solid: tick
      <em>Filled</em> for it in OpenRocket. The details are saved into the part's comment when you save the .ork.</p>
    </details>
    <h3>Download this part</h3>
    <div class="row">
      <button data-format="step">STEP (for Onshape)</button>
      <button data-format="stl">STL (for printing)</button>
    </div>`;
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
  for (const b of selectedEl.querySelectorAll<HTMLButtonElement>("button[data-format]")) {
    b.disabled = !p.mesh;
    b.addEventListener("click", () => void download({ type: "file", key: p.key, format: b.dataset.format as "step" | "stl" }, b));
  }
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
saveButton.addEventListener("click", async () => {
  if (!(await download({ type: "save" }, saveButton))) return;
  unsaved = false;
  setStatus(`Saved ${fileName} with your details. It opens in OpenRocket as usual; the details are in each part's comment.`);
});

function setStatus(text: string, problem = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("problem", problem);
}
