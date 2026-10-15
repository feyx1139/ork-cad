// "Add a detail": a form for each kind of detail, with labelled boxes, a short explanation of each
// setting and a diagram, that writes the detail line for you, so nobody has to learn the "@" lines.
// It also reads a line back into the form, to change it.

import { NUT_NAMES } from "../src/features/hardware.ts";
import { parseFeatures } from "../src/features/parse.ts";

type Values = Record<string, string>;

interface Field {
  key: string;
  label: string;
  help?: string;
  type: "number" | "length" | "angle" | "choice" | "onoff";
  options?: [string, string][];
  default?: string;
  /** Can be left empty (then the line leaves it out and ork-cad's default is used). */
  optional?: boolean;
  /** Only shown when this is true (e.g. a pocket's width only for a rectangular pocket). */
  when?: (v: Values) => boolean;
  /** Only shown under "More settings". */
  more?: boolean;
  /** What ork-cad takes when the setting is left out: the line leaves it out when it's this. */
  same?: string;
}

interface Kind {
  kind: string;
  name: string;
  /** What it is, in a sentence. */
  what: string;
  /** The part types it goes on (OpenRocket's names). */
  on: string[];
  fields: Field[];
  diagram: string;
  /**
   * Settings that aren't one box each (a pocket's size, a chamfer's length or inset): the boxes
   * toArgs reads, the settings it writes, and fromArgs to fill the boxes from a line.
   */
  managed?: string[];
  writes?: string[];
  toArgs?: (v: Values) => [string, string][];
  fromArgs?: (args: Values) => Values;
}

const ROUND_PARTS = ["nosecone", "transition"];
const TUBES = ["bodytube", "innertube", "tubecoupler", "launchlug"];
const END: [string, string][] = [
  ["fore", "the top end (toward the nose)"],
  ["aft", "the bottom end (toward the tail)"],
];

const TOP_HELP = "Top is toward the nose, as the rocket stands on the launch pad.";
const ANGLE_HELP = "Turns it around the rocket: 0 lines it up with the first fin.";

export const KINDS: Kind[] = [
  {
    kind: "side-holes",
    name: "Holes through the wall",
    what: "Round holes straight through the side, e.g. altimeter vents or holes for a screw. Several are spread evenly around.",
    on: [...ROUND_PARTS, ...TUBES],
    fields: [
      { key: "count", label: "How many", type: "number", default: "4", help: "Spread evenly around the part." },
      { key: "diameter", label: "Hole size (mm across)", type: "length", default: "2" },
      { key: "at", label: "Distance (mm)", type: "length", default: "10", help: "How far along the part, from the place below. Negative goes into the top shoulder." },
      { key: "from", label: "Measured from", type: "choice", options: [...END, ["middle", "the middle of the part"]], default: "fore", same: "fore", help: TOP_HELP },
      { key: "angle", label: "Turned (degrees)", type: "angle", default: "0", same: "0", help: ANGLE_HELP, optional: true },
    ],
    diagram: svg(`
      <rect x="70" y="14" width="60" height="106" class="part"/>
      <text x="100" y="10" class="t">top end</text>
      <ellipse cx="88" cy="58" rx="3" ry="4" class="hole"/><ellipse cx="112" cy="58" rx="3" ry="4" class="hole"/>
      <line x1="150" y1="14" x2="150" y2="58" class="dim" marker-start="url(#a)" marker-end="url(#a)"/>
      <line x1="130" y1="58" x2="154" y2="58" class="guide"/>
      <text x="156" y="40" class="d" text-anchor="start">at</text>
      <line x1="115" y1="61" x2="140" y2="84" class="lead"/><text x="143" y="88" class="d" text-anchor="start">diameter</text>`),
  },
  {
    kind: "end-holes",
    name: "Holes through a cap or ring",
    what: "Holes along the rocket's axis, through a shoulder's cap, a bulkhead or a centering ring (for a shock cord, say).",
    on: [...ROUND_PARTS, "bulkhead", "centeringring", "engineblock"],
    fields: [
      { key: "count", label: "How many", type: "number", default: "1" },
      { key: "diameter", label: "Hole size (mm across)", type: "length", default: "3" },
      { key: "radius", label: "Distance from the middle (mm)", type: "length", default: "0", help: "0 for one hole in the middle; several holes go round at this distance." },
      { key: "end", label: "Which cap", type: "choice", options: [["", "the only capped end"], ...END], default: "", optional: true, help: "Only needed on a nose cone or transition with both shoulders capped." },
      { key: "angle", label: "Turned (degrees)", type: "angle", default: "0", same: "0", optional: true, help: ANGLE_HELP },
    ],
    diagram: svg(`
      <circle cx="100" cy="66" r="50" class="part"/><circle cx="100" cy="66" r="28" class="guide"/>
      <circle cx="128" cy="66" r="5" class="hole"/><circle cx="72" cy="66" r="5" class="hole"/>
      <circle cx="100" cy="38" r="5" class="hole"/><circle cx="100" cy="94" r="5" class="hole"/>
      <line x1="100" y1="66" x2="123" y2="66" class="dim" marker-end="url(#a)"/><text x="110" y="80" class="d">radius</text>
      <text x="100" y="128" class="t">looking along the rocket</text>`),
  },
  {
    kind: "pocket",
    name: "Pocket",
    what: "A cavity cut into a solid part from one end, along its axis, e.g. for the altimeter.",
    on: ROUND_PARTS,
    fields: [
      { key: "shape", label: "Shape", type: "choice", options: [["rect", "rectangular (fits a box-shaped altimeter)"], ["round", "round"]], default: "rect" },
      { key: "width", label: "Width (mm)", type: "length", default: "20", when: (v) => v.shape !== "round" },
      { key: "height", label: "Other side (mm)", type: "length", default: "20", when: (v) => v.shape !== "round" },
      { key: "corner", label: "Round the corners (mm)", type: "length", optional: true, when: (v) => v.shape !== "round" },
      { key: "diameter", label: "Diameter (mm)", type: "length", default: "20", when: (v) => v.shape === "round" },
      { key: "depth", label: "Depth (mm)", type: "length", default: "40" },
      { key: "end", label: "Opens at", type: "choice", options: END, default: "fore", same: "fore", help: "Put it at the end away from the ejection charge." },
      { key: "round", label: "Round the opening (mm)", type: "length", optional: true, help: "Rounds the edge of the opening, to guide what goes in." },
      { key: "angle", label: "Turned (degrees)", type: "angle", optional: true, when: (v) => v.shape !== "round", more: true },
    ],
    managed: ["shape", "width", "height", "corner", "diameter"],
    writes: ["size", "corner", "diameter"],
    toArgs: (v) =>
      v.shape === "round"
        ? [["diameter", v.diameter]]
        : [
            ["size", v.width && v.height ? `${v.width}x${v.height}` : ""],
            ["corner", v.corner],
          ],
    fromArgs: (a): Values => {
      if (a.diameter) return { shape: "round", diameter: a.diameter };
      const [width = "", height = ""] = (a.size ?? "").split(/[x×]/i);
      return { shape: "rect", width, height, corner: a.corner ?? "" };
    },
    diagram: svg(`
      <rect x="60" y="30" width="80" height="94" class="part"/>
      <rect x="85" y="30" width="30" height="58" class="cut"/>
      <text x="100" y="12" class="t">top end</text>
      <line x1="85" y1="22" x2="115" y2="22" class="dim" marker-start="url(#a)" marker-end="url(#a)"/><text x="134" y="25" class="d" text-anchor="start">width</text>
      <line x1="155" y1="30" x2="155" y2="88" class="dim" marker-start="url(#a)" marker-end="url(#a)"/><text x="160" y="62" class="d" text-anchor="start">depth</text>
      <line x1="115" y1="88" x2="158" y2="88" class="guide"/>
      <text x="100" y="132" class="t">cut through the part</text>`),
  },
  {
    kind: "nut-trap",
    name: "Captive nut",
    what: "A pocket that holds a hex nut inside a solid part, with a hole for the screw along the axis (for an eyebolt, say). The nut goes in through a slot in the side and can't turn or fall out.",
    on: ROUND_PARTS,
    fields: [
      { key: "size", label: "Screw size", type: "choice", options: NUT_NAMES.map((n) => [n, n]), default: "M4" },
      { key: "depth", label: "Plastic before the nut (mm)", type: "length", default: "12", help: "Between the end face and the nut: more is stronger." },
      { key: "end", label: "Screw goes in at", type: "choice", options: END, default: "aft", same: "aft" },
      { key: "angle", label: "Slot faces (degrees)", type: "angle", optional: true, help: "Which way round the slot opens. In a shoulder, the tube covers it." },
    ],
    diagram: svg(`
      <rect x="60" y="10" width="80" height="110" class="part"/>
      <rect x="80" y="70" width="40" height="12" class="cut"/><rect x="120" y="70" width="20" height="12" class="cut"/>
      <rect x="96" y="60" width="8" height="60" class="cut"/>
      <text x="100" y="128" class="t">bottom end</text>
      <line x1="45" y1="82" x2="45" y2="120" class="dim" marker-start="url(#a)" marker-end="url(#a)"/><text x="40" y="104" class="d" text-anchor="end">depth</text>
      <text x="146" y="79" class="d" text-anchor="start">slot</text>`),
  },
  {
    kind: "chamfer",
    name: "Bevelled edge",
    what: "Bevels the outside edge at an end, e.g. a lead-in so a shoulder slides into its tube.",
    on: ROUND_PARTS,
    fields: [
      { key: "end", label: "Which end", type: "choice", options: END, default: "aft" },
      { key: "by", label: "Size given as", type: "choice", options: [["inset", "how far in it cuts at the end face"], ["length", "how far along the rocket it goes"]], default: "inset" },
      { key: "amount", label: "Size (mm)", type: "length", default: "1" },
      { key: "angle", label: "Angle from the rocket's axis (degrees)", type: "angle", default: "45", same: "45", help: "45° or less prints without supports on that end." },
      { key: "round", label: "Blend in with a round (mm)", type: "length", optional: true },
    ],
    managed: ["by", "amount"],
    writes: ["inset", "length"],
    toArgs: (v) => [[v.by === "length" ? "length" : "inset", v.amount]],
    fromArgs: (a) => (a.length ? { by: "length", amount: a.length } : { by: "inset", amount: a.inset ?? "" }),
    diagram: svg(`
      <path d="M50 10 L120 10 L120 90 L100 120 L50 120 Z" class="part"/>
      <line x1="120" y1="90" x2="150" y2="90" class="guide"/>
      <line x1="150" y1="90" x2="150" y2="120" class="dim" marker-start="url(#a)" marker-end="url(#a)"/><text x="154" y="110" class="d" text-anchor="start">length</text>
      <line x1="100" y1="127" x2="120" y2="127" class="dim" marker-start="url(#a)" marker-end="url(#a)"/><text x="132" y="130" class="d" text-anchor="start">inset</text>
      <text x="85" y="60" class="t">cut through</text><text x="85" y="72" class="t">the part</text>`),
  },
  {
    kind: "round",
    name: "Rounded edge",
    what: "Rounds off the outside edge at an end.",
    on: ROUND_PARTS,
    fields: [
      { key: "end", label: "Which end", type: "choice", options: END, default: "fore" },
      { key: "radius", label: "Radius (mm)", type: "length", default: "2" },
    ],
    diagram: svg(`
      <path d="M50 120 L120 120 L120 40 Q120 10 90 10 L50 10 Z" class="part"/>
      <line x1="90" y1="40" x2="111" y2="19" class="dim" marker-end="url(#a)"/><text x="80" y="50" class="d">radius</text>`),
  },
  {
    kind: "solid",
    name: "Print solid",
    what: "Builds the part filled with plastic (like ticking Filled in OpenRocket), so pockets and nuts can go in it. Set the material to your infill's density in OpenRocket so the mass stays right.",
    on: ROUND_PARTS,
    fields: [],
    diagram: "",
  },
  {
    kind: "screw-joint",
    name: "Screw joint",
    what: "Prints the tube in two pieces that screw together, e.g. a fin section that unscrews: a threaded plug on the bottom piece screws into the top piece until the ends meet.",
    on: ["bodytube"],
    fields: [
      { key: "at", label: "Where the pieces meet (mm)", type: "length", default: "100" },
      { key: "from", label: "Measured from", type: "choice", options: END, default: "aft", same: "fore" },
      { key: "pitch", label: "Thread: mm per turn", type: "length", default: "3", same: "3", optional: true, help: "Coarse threads print well." },
      { key: "detent", label: "Clicks into place", type: "onoff", default: "on", same: "on", help: "Two small bumps click into dimples when it's screwed home." },
      { key: "length", label: "Thread length (mm)", type: "length", optional: true, more: true, help: "Default 5 turns." },
      { key: "clearance", label: "Gap between the threads (mm)", type: "length", optional: true, more: true, help: "Default 0.3: more if your printer's parts come out tight." },
      { key: "depth", label: "Thread depth (mm)", type: "length", optional: true, more: true },
      { key: "angle", label: "Bumps turned (degrees)", type: "angle", optional: true, more: true },
    ],
    diagram: svg(`
      <rect x="70" y="10" width="60" height="58" class="part"/>
      <rect x="70" y="70" width="60" height="50" class="part"/>
      <path d="M80 70 L80 40 L84 37 L80 34 M120 70 L120 40 L116 37 L120 34" class="thread"/>
      <rect x="80" y="34" width="40" height="36" class="plug"/><text x="100" y="56" class="t">plug</text>
      <line x1="150" y1="70" x2="150" y2="120" class="dim" marker-start="url(#a)" marker-end="url(#a)"/><text x="155" y="98" class="d" text-anchor="start">at</text>
      <text x="100" y="128" class="t">bottom end</text>`),
  },
  {
    kind: "one-piece",
    name: "Print the fins with the tube",
    what: "Prints the fins as part of the body tube they're on, in the tube's file: nothing to glue or line up.",
    on: ["trapezoidfinset", "ellipticalfinset", "freeformfinset"],
    fields: [],
    diagram: "",
  },
];

/**
 * The line a form writes: its boxes (left out when empty, or what ork-cad takes anyway), the
 * settings made from several boxes, and settings the form has no box for, kept from the line it
 * was opened with.
 */
export function lineOf(kind: Kind, values: Values, kept: [string, string][] = []): string {
  const args: [string, string][] = [];
  const managed = new Set(kind.managed ?? []);
  let made = false;
  for (const f of kind.fields) {
    if (managed.has(f.key)) {
      // The settings made from several boxes go where the first of those boxes is.
      if (!made) for (const [k, v] of kind.toArgs?.({ ...defaults(kind), ...values }) ?? []) if (v?.trim()) args.push([k, v.trim()]);
      made = true;
      continue;
    }
    if (f.when && !f.when(values)) continue;
    const v = (values[f.key] ?? f.default ?? "").trim();
    if (v !== "" && v !== f.same) args.push([f.key, v]);
  }
  args.push(...kept);
  return [`@${kind.kind}`, ...args.map(([k, v]) => `${k}=${v.replace(/\s+/g, "")}`)].join(" ");
}

function defaults(kind: Kind): Values {
  return Object.fromEntries(kind.fields.flatMap((f) => (f.default !== undefined ? [[f.key, f.default]] : [])));
}

/** The kinds of detail a part of this type can have. */
export function kindsFor(type: string): Kind[] {
  return KINDS.filter((k) => k.on.includes(type));
}

/**
 * Shows the form in `box`: for a new detail, or (with `line`) to change that one. `submit` gets
 * the finished line.
 */
export function showForm(box: HTMLElement, type: string, line: string | undefined, submit: (line: string) => void, cancel: () => void): void {
  const kinds = kindsFor(type);
  box.hidden = false;
  box.replaceChildren();
  if (!kinds.length) {
    box.append(el("p", "muted", "This kind of part has no details to add."));
    return;
  }
  // A line being changed: its kind and settings (settings the form has no box for are kept).
  let kind = kinds[0];
  let values: Values = {};
  let kept: [string, string][] = [];
  if (line) {
    const m = /^@([a-z-]+)\s*(.*)$/i.exec(line.trim());
    const found = m && kinds.find((k) => k.kind === m[1].toLowerCase());
    if (found) {
      kind = found;
      const args: Values = {};
      for (const token of m[2].split(/[\s,;]+/).filter(Boolean)) {
        const eq = token.indexOf("=");
        if (eq > 0) args[token.slice(0, eq).toLowerCase()] = token.slice(eq + 1);
      }
      const special = kind.fromArgs?.(args) ?? {};
      const boxes = new Set(kind.fields.map((f) => f.key));
      values = { ...Object.fromEntries(Object.entries(args).filter(([k]) => boxes.has(k))), ...special };
      const used = new Set([...boxes, ...(kind.writes ?? [])]);
      kept = Object.entries(args).filter(([k]) => !used.has(k));
    }
  }

  const head = el("div", "form-head");
  const picker = document.createElement("select");
  for (const k of kinds) picker.append(new Option(k.name, k.kind, false, k === kind));
  picker.disabled = Boolean(line);
  head.append(el("label", "", line ? "Change this detail" : "Add"), picker);
  const body = el("div", "form-body");
  const preview = el("code", "form-line");
  const problem = el("p", "error");
  const actions = el("div", "row");
  const ok = el("button", "primary", line ? "Save" : "Add") as HTMLButtonElement;
  const no = el("button", "", "Cancel") as HTMLButtonElement;
  actions.append(ok, no);
  box.append(head, body, el("p", "muted small", "The line it writes (you can also edit the text below):"), preview, problem, actions);

  let current = "";
  const render = () => {
    body.replaceChildren();
    body.append(el("p", "form-what", kind.what));
    const grid = el("div", "form-grid");
    const fields = el("div", "form-fields");
    if (kind.diagram) {
      const pic = el("div", "form-diagram");
      pic.innerHTML = kind.diagram;
      grid.append(fields, pic);
    } else {
      grid.append(fields);
    }
    body.append(grid);
    const more = el("details", "form-more");
    more.append(el("summary", "", "More settings"));
    for (const f of kind.fields) {
      if (values[f.key] === undefined && f.default !== undefined) values[f.key] = f.default;
      if (f.when && !f.when(values)) continue;
      const row = el("label", "form-field");
      row.append(el("span", "form-label", f.label));
      let input: HTMLInputElement | HTMLSelectElement;
      if (f.type === "choice" || f.type === "onoff") {
        input = document.createElement("select");
        const options = f.type === "onoff" ? [["on", "yes"], ["off", "no"]] : f.options!;
        for (const [value, label] of options) input.append(new Option(label, value, false, values[f.key] === value));
        input.addEventListener("change", () => {
          values[f.key] = input.value;
          // Some settings show or hide others (a round pocket has no width).
          if (kind.fields.some((g) => g.when)) render();
          else update();
        });
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.inputMode = "decimal";
        input.value = values[f.key] ?? "";
        input.placeholder = f.optional ? "(leave empty for none)" : "";
        input.addEventListener("input", () => {
          values[f.key] = input.value.trim();
          update();
        });
      }
      row.append(input);
      if (f.help) row.append(el("span", "form-help", f.help));
      (f.more ? more : fields).append(row);
    }
    if (more.children.length > 1) fields.append(more);
    update();
  };
  const update = () => {
    current = lineOf(kind, values, kept);
    preview.textContent = current;
    const { errors } = parseFeatures(current);
    problem.textContent = errors.length ? errors[0].replace(/^"[^"]*": /, "Not right yet: ") : "";
    ok.disabled = errors.length > 0;
  };
  picker.addEventListener("change", () => {
    kind = kinds.find((k) => k.kind === picker.value)!;
    values = {};
    kept = [];
    render();
  });
  ok.addEventListener("click", () => submit(current));
  no.addEventListener("click", () => {
    box.hidden = true;
    box.replaceChildren();
    cancel();
  });
  render();
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A diagram's SVG, with the arrowheads and styles they all share. */
function svg(inner: string): string {
  return `<svg viewBox="0 0 200 134" role="img" aria-hidden="true">
    <defs><marker id="a" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="arrow"/></marker></defs>
    <g text-anchor="middle">${inner}</g></svg>`;
}
