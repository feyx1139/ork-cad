# ork-cad

**Use it in your browser: https://feyx1139.github.io/ork-cad/** (nothing to install, and your
files stay on your computer).

Turns OpenRocket designs (`.ork`) into parts ready for 3D printing: STL files made from exact CAD
(real curves, cut into triangles within 0.01 mm), not the coarse mesh OpenRocket's own export
makes, and exact STEP files for Onshape when you want to edit a part. Holes, pockets, nut traps and
other print details that OpenRocket can't model are added from lines in each part's comment. A
part you made in CAD yourself can be compared with the design, and the changes that make the design
match it are worked out for you. The parts are checked against OpenRocket itself. It runs as a
website and as a command-line tool, and both use the same code in `src/`.

Needs Node.js 24 or newer. To run it from a copy of this repository:

```
npm install
```

## The website

```
npm run dev
```

Then open http://localhost:5173. Open or drop an `.ork`, and the parts appear in 3D.
- **Parts list:** shows each part's plastic volume and mass.
- **Sealed spaces:** show what's inside each space and which holes vent it.
- **Clicking a part:** shows its details editor. Type detail lines (see below), press **Apply**, and
  the part rebuilds.
- **Cut in half:** shows walls, pockets and vents from the inside.
- **Compare with your CAD file:** for a nose cone or transition, pick a STEP or STL file of the real
  part. The page lists what to change in OpenRocket and which detail lines to add, checks the
  result against your file, and **Make these changes** puts them into the design (see
  [Comparing with a part made in CAD](#comparing-with-a-part-made-in-cad)).
- **Downloads:**
  - **STL for printing:** a zip with an STL for every part, ready for the slicer, and a report.
    Each STL holds one copy; a fin set's file is one fin, and its name says how many to print.
  - **STEP for Onshape:** the whole rocket in one STEP file. Every part (every fin too) is a
    separate, named piece with exact curved surfaces, in its place, so in Onshape each part is
    listed on its own and measures exactly. An STL can't do that: it's only triangles, so Onshape
    shows it as one lump of mesh ("Import 1") without exact sizes.
  - **STL / STEP** with a selected part: just that part.
  - **Save .ork:** your design with the details written into each part's comment. OpenRocket opens
    it as usual.

Everything runs in the browser: the CAD engine (OpenCASCADE, about 7 MB to download the first time)
works in a background worker, and the file never leaves the computer. `npm run build` makes `dist/`,
a static site that can go on any web host; `.github/workflows/pages.yml` publishes it to GitHub
Pages.

## The command line

```
npm run export -- my-rocket.ork
```

That writes `out/my-rocket/`:
- one STL file per part, numbered nose to tail (one copy of the part; a fin set's file is one fin,
  named with how many to print);
- `report.txt` with each part's volume and its mass at the material set in OpenRocket, plus the
  sealed spaces.

Every part is in its place on the rocket: the rocket's axis is Z and the nose tip is at Z = the
rocket's length, as in OpenRocket's own OBJ export. Slicers move parts onto the bed by themselves.

**Onshape:** use STEP, not STL: Onshape imports an STL as one mesh, without separate parts or
exact sizes. Add `--step` (`npm run export -- my-rocket.ork --step`) for `assembly.step`, the
whole rocket as an assembly with every part a separate named piece with exact curved surfaces, in
its place (the same file as the website's **STEP for Onshape**), and a STEP file per part. In an
Onshape document, **+ → Import** and pick the file.

## Comparing with a part made in CAD

If a nose cone or transition was drawn by hand (in Onshape, say), ork-cad can work out what to
change in the design so it makes that part, instead of you measuring it and typing it in:

```
npm run match -- my-rocket.ork "Nose cone" nose.step --write my-rocket-matched.ork
```

Export the part from Onshape as STEP (right-click it, **Export**) or STL; either works, in any
units and any position. ork-cad finds the part's axis and outline and reports:
- **Changes for OpenRocket:** shoulder diameters and lengths, the body's length and end radii, and
  **Filled** if the part is solid. A radius OpenRocket sets to "auto" (from the tube next to it) is
  left alone, with a note if the file differs.
- **Detail lines:** chamfers and rounds on the shoulders' ends, rings of side holes, pockets
  (round or rectangular) and nut traps in the end faces.
- **A check:** it builds the part with all of that and compares the two surfaces point by point.
  Either it matches (for example "no point of either surface is more than 0.024 mm from the other")
  or it lists where they still differ, such as a shape it doesn't recognise yet.

`--write` saves a copy of the design with the changes made; the website's **Make these changes**
does the same. Angles around the axis are measured from the file's X axis, which is taken as the
direction of the first fin. A transition the same size at both ends can't show which end is the
fore end, so the end toward the file's +Z is taken (as in Onshape when the nose points up);
`--flip` (or **Compare the other way round**) takes the other end.

## Details OpenRocket can't model

Details are lines starting with `@` in a component's **Comment** tab in OpenRocket. They're saved
in the `.ork`, so they stay with the part when the design changes or is shared, and any other
comment text is left alone. Positions are measured from the part's own ends, so if you make a part
longer, its details move with it.

For example, these lines on a solid printed transition make an altimeter bay in it: a pocket
opening at the fore end, four vents into it, a captive nut at the aft end for the shock cord's
eyebolt, a lead-in on the aft shoulder and a rounded fore rim.

```
@pocket size=24x18 depth=40 corner=4 end=fore
@side-holes count=4 diameter=2 at=10
@nut-trap size=M5 depth=12 end=aft angle=90
@chamfer end=aft length=6 angle=30 round=3
@round end=fore radius=3
```

- **`@side-holes`** go through the wall, straight out from the rocket's axis.
  - `at`: how far along the part, from the end named by `from` (`fore`, `aft` or `middle`;
    default `fore`). A negative `at` goes into the shoulder.
  - `count`: holes are spread evenly around the part.
  - `angle`: where the first hole goes. It's measured like OpenRocket's own angles, so 0 lines up
    with the first fin.
  - Works on nose cones, transitions and tubes.
- **`@end-holes`** go through a shoulder cap, bulkhead, centering ring or engine block, parallel to
  the axis.
  - `radius`: how far the hole centres are from the axis.
  - `end`: which cap (`fore` or `aft`). It can be left out when only one shoulder is capped.
- **`@pocket`** is a cavity cut in from an end along the axis, e.g. for the altimeter.
  - `size=WxH` with an optional `corner` radius, or `diameter` for a round pocket.
  - `depth`: how far in it goes.
  - `end`: which end it opens at (`fore` or `aft`; default `fore`).
  - `angle`: turns it around the axis.
- **`@nut-trap`** holds a hex nut inside the part, so a screw or eyebolt can go in from the end
  along the axis (to anchor a shock cord, for example).
  - `size`: `M3`–`M6`, `#4-40`, `#6-32`, `#8-32`, `#10-24`, `#10-32` or `1/4-20`.
  - `depth`: how much plastic is between the end face and the nut.
  - `end`: default `aft`.
  - `angle`: the direction of the slot the nut slides in through. The slot is hidden inside the
    tube when it's in a shoulder.
  - The pocket gets 0.6 mm extra across the flats and 0.8 mm extra in thickness. You can override
    `hole`, `flats`, `thickness` and `bolt` (screw hole depth; default 3 mm past the nut).
- **`@chamfer`** bevels the outside edge at an end, e.g. a lead-in so a shoulder slides into its
  tube.
  - `length`: how far along the axis it goes, or `inset`: how far in from the outside it cuts at
    the end face, the way a sketch would dimension it. Give one of the two. `inset=3` on a 65 mm
    shoulder leaves a 59 mm end face.
  - `angle`: measured from the axis (default 45). At 45 or less, the bevel prints without supports
    when the part stands on that end.
  - `round`: an optional radius that blends the start of the bevel.
- **`@round`** rounds the outside edge at an end with `radius`.
- **Solid parts:** pockets and nut traps need a solid part. Tick **Filled** for the part in
  OpenRocket, and set its material to your infill density so the mass stays right. A filled part is
  built solid, shoulders included; OpenRocket's mass model still counts a filled part's shoulders
  as tubes with the shoulder thickness, so set that to the shoulder radius too.
- **Units:** lengths are mm unless written otherwise (`2mm`, `0.3cm`, `1/8in`); angles are
  degrees.

You can type a line into OpenRocket's comment box, or add it to a copy of the design:

```
npm run add-detail -- my-rocket.ork out/my-rocket-vents.ork "Transition" "@side-holes count=3 diameter=2 at=40 angle=45"
```

The command checks the line and builds the part before writing anything, and it never overwrites
the input file. Lines that don't fit stop the export with the reason. For example: holes that would
run off the part, overlap each other, miss the cap, or sit outside the shoulder wall. Notes point
out holes that another part covers once assembled (drill that part to match) and holes under 1 mm,
which tend to close up when printed.

**Sealed spaces.** The export lists the rocket's sealed spaces, nose to tail. For each one it shows:
- where the space starts and ends (the caps, bulkheads and centering rings around it);
- what's inside it;
- whether the motor's ejection charge fires into it;
- which holes open into it;
- its air volume and inside diameter, which altimeter vent-size charts ask for.

It warns when:
- the altimeter's space has no vent holes;
- ejection gas could reach the altimeter or the eggs.

## What it builds

| OpenRocket part | Built as |
|---|---|
| Nose cones, transitions (conical, ogive, ellipsoid, power, parabolic, Haack; clipped or not) | Revolved solid. Cone, ellipsoid and ogive outsides are exact lines, ellipses and circular arcs (arcs as their exact rational B-spline); the other shapes and curved insides are B-splines within 0.00001 mm of the formula |
| Wall thickness | Measured perpendicular to the surface, as OpenRocket's mass model intends, so the wall is even all the way to the tip |
| Shoulders | Tube with a cap as thick as its wall when "capped" is ticked |
| Body tubes, inner tubes, couplers, centering rings, bulkheads, engine blocks, launch lugs | Exact tubes/discs |
| Trapezoidal, elliptical (true ellipse) and freeform fins, fin tabs | Exact outline, extruded to the fin thickness |
| Rail buttons | Same shape as OpenRocket's (base, neck, flange, optional screw head) |
| Mass components, parachutes, shock cords | Nothing (no printable shape) |

Sizes set to "auto" in OpenRocket are worked out the way OpenRocket 24.12 does: radii from the
neighbouring body parts (across stages too), rings and bulkheads from the tube they sit in, and
packed parachutes from their tube, keeping their packed volume.

Fin tabs go where OpenRocket 24.12 puts them when it opens the file. For elliptical fins that isn't
where the saved position says: OpenRocket places the tab as if the fin were 50 mm long, and every
time the file is opened and saved there, the tab moves again. The part follows OpenRocket and a note
says so. Measuring the tab's position from the fin's front (top) in OpenRocket avoids the problem.

Not supported yet (those parts are listed as not built, with the reason): pods and side boosters,
motor clusters, flipped nose cones (tail cones), canted fins, fins on a nose cone or transition,
tube fins. Rounded or airfoil fin edges are built square for now, and fin fillets aren't built yet
(it says so when a design has them). Shoulders with 0 mm walls are left out, since they can't be
printed. A shoulder narrower than the inside of the part it's on doesn't touch the wall, so it comes
out as a separate piece (with a note).

## How it's checked

`npm test` runs these checks on four of the example rockets that come with OpenRocket 24.12 and on
a test rocket with one fin set for each way OpenRocket places a fin tab (all in `test/fixtures/`),
and on any designs of your own in `test/private/fixtures/`, a folder git ignores.

- **Positions:** every component sits exactly where OpenRocket puts it (all copies, to 0.000001 mm),
  and the rocket's length is OpenRocket's, which counts fins or a motor tube reaching past the
  airframe.
- **Volumes:** tubes, rings, bulkheads, launch lugs, rail buttons and fins match OpenRocket's mass
  model to 0.00001%. The known differences are worked out rather than allowed for: OpenRocket takes
  1% off a fin for rounded edges (15% for airfoils) while we build square edges, and it stores an
  elliptical fin as a 31-point polygon, 0.18% smaller than the ellipse.
- **Nose cones and transitions:** OpenRocket's mass model adds up 128 slices of the wall. A copy of
  that formula reproduces OpenRocket's volume for every one of them to 0.0000001%, so the
  dimensions are identical; our solid matches the exact volume of a wall measured perpendicular to
  the surface (worked out without the CAD kernel) to 0.00001%. The two differ by OpenRocket's
  slicing: 0.002% for most noses, 1.2% for the very blunt ellipsoid in the base-drag example.
- **Surfaces:** every vertex of OpenRocket's own OBJ export lies on our parts' outside surfaces,
  within 0.001 mm (the rounding of OpenRocket's 32-bit OBJ numbers).
- **Every shape type:** all six nose/transition shapes, as nose cones and as growing, shrinking and
  clipped transitions, follow OpenRocket's formulas to 0.0001 mm inside and out, have the exact wall
  volume (except where the wall is thicker than the shape's curvature at a sharp end, which is
  trimmed and reported), and come back unchanged from a STEP file.
- **STL files:** every one is a closed surface (each edge joins exactly two triangles, facing
  opposite ways), its corners lie on the exact surface (to 0.0001 mm), and its volume is within
  what the 0.01 mm triangle allowance can change (0.01–0.07% for nose cones).
- **STEP files:** every file re-imports with the same volume, number of solids and position, and
  the whole-rocket file is an assembly of named parts, one per piece, in millimetres.
- **Details:**
  - Side holes through a curved nose cone wall remove exactly the material worked out by
    integration, and end holes through a cap or bulkhead exactly their volume.
  - Pockets, a rounded rim, rounded lead-in chamfers (given by length or by inset) and a captive
    nut (with its slot and screw hole) cut into the ARC example's solid balsa nose cone each remove
    exactly the volume worked out by hand, and vents open into the pocket.
  - Mistakes in detail lines are refused with a reason.
- **Comparing with CAD files:** parts built with known changes (a longer, narrower shoulder with a
  rounded lead-in, side holes through a curved wall, pockets, a nut trap, a rounded rim, Filled),
  written as STEP and as STL, moved, turned, tilted and in inches, compared with the design: each
  time it finds exactly those changes again, the part built with them matches the file, and the
  design written with them builds the same part.
- **Sealed spaces:** the ARC example's spaces, with an altimeter in its payload bay: the vent
  warning, the vents, ejection gas through a bulkhead, and the air volume.
- **Edited files:** `.ork` files change only the comment, and OpenRocket itself opens them and reads
  the comment back (that check is skipped where OpenRocket isn't installed).
- **Website:** the website's session opens the 3D-printable example, meshes every part, edits
  details (including bad ones, which are shown next to the part), makes every download, and
  compares the nose cone with an STL of a changed one and takes the changes on, all checked in
  Node.

The reference data in `test/fixtures/*.openrocket.*` comes from OpenRocket itself, made headlessly
with OpenRocket's own Java runtime and jar by `tools/openrocket-ref/RefExport.java`. To add a design
to the tests:

```
npm run reference -- test/fixtures/new-design.ork
```

This needs OpenRocket installed (set `OPENROCKET_HOME` if it isn't in `C:\Program Files\OpenRocket`).
`tools/openrocket-ref/build/RefExport.class` is precompiled. To rebuild it, compile with the Eclipse
compiler, which runs on OpenRocket's Java 17:

```
"%OPENROCKET_HOME%\jre\bin\java" -jar ecj-3.38.0.jar -17 -cp "%OPENROCKET_HOME%\jar\OpenRocket-24.12.jar" -d tools/openrocket-ref/build tools/openrocket-ref/RefExport.java
```

## What OpenRocket's OBJ export gets wrong for printing

Found while building the tests:

- **Capped shoulders:** it exports any nose cone with a capped shoulder as completely solid, and
  capped shoulders as solid plugs. The 3D-printable example's nose cone comes out as 34.8 cm³ of
  solid shape instead of the 12.5 cm³ hollow part designed (2.8×); the base-drag example's, 7.5×.
- **Wall thickness:** where it does keep a wall, it subtracts the thickness radially instead of
  perpendicular to the surface. On a rounded nose that makes the wall thin near the tip.
- **Ellipses:** it turns elliptical fins into 31-sided polygons and curves into flat facets.

## Layout

- `src/ork/read.ts`: unzips the `.ork` file and reads its XML into a component tree.
- `src/ork/model.ts`: turns the tree into typed parts. All sizes are in mm. Positions follow
  OpenRocket's top/middle/bottom/after/absolute rules and resolve "auto" sizes.
- `src/geometry/shapes.ts`: OpenRocket's nose and transition formulas, ported line for line.
- `src/geometry/parts.ts`: builds the solids with replicad (OpenCASCADE compiled to WebAssembly,
  so the same code runs in the browser).
- `src/features/`: reads the `@` detail lines (`parse.ts`, screw sizes in `hardware.ts`) and cuts
  them (`holes.ts`, `cuts.ts`; `apply.ts` runs them all).
- `src/checks/compartments.ts`: the sealed spaces and the vent checks.
- `src/ork/write.ts`: writes a component comment back into an `.ork`.
- `src/export/files.ts`, `report.ts`: write the STL and STEP files and the report
  (`src/geometry/stl.ts` reads and writes STL).
- `src/match/`: comparing a part with a CAD file: reading it and finding its axis and outline
  (`cad.ts`), working out the changes and checking them (`compare.ts`), and surface distances
  (`distance.ts`).
- `web/`: the website.
  - `main.ts`: the page.
  - `viewer.ts`: the 3D view (three.js).
  - `worker.ts`: the CAD engine's background worker.
  - `session.ts`: the open design (opening, building, editing details, downloads). It's tested in
    Node.
- `scripts/`: command-line tools.
- `test/`: the checks above.

## License

ork-cad is free software under the GNU General Public License, version 3 or later (see
`LICENSE`). Its shape, position and "auto" size rules are ported from
[OpenRocket](https://openrocket.info), which is also GPL v3, and `test/fixtures/` holds example
rockets that come with OpenRocket (see `test/fixtures/README.md`).
