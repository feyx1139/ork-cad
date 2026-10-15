# ork-cad

**Use it in your browser: https://feyx1139.github.io/ork-cad/** (nothing to install, and your
files stay on your computer).

Turns OpenRocket designs (`.ork`) into parts ready for 3D printing: STL files made from exact CAD
(real curves, cut into triangles within 0.01 mm), not the coarse mesh OpenRocket's own export
makes, and exact STEP files for Onshape when you want to edit a part. Holes, pockets, nut traps and
other print details that OpenRocket can't model are added from lines in each part's comment, and
printed parts get the usual ones by themselves (altimeter vents and pocket, an eyebolt nut,
lead-ins on the shoulders), each with the reason, to keep, change or turn off. A
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
- **Clicking a part:** says what it is in plain words ("Body tube: 66 mm across (64 inside), 305 mm
  long"), what it's for, and where it is (mm from the nose tip), and lists its details, each in
  words ("4 holes, 2 mm across, straight through the wall 60 mm from the top end…").
  - **Show in 3D** marks what a detail does on the part: the plastic it cuts away in red, the
    plastic it adds in green (worked out exactly, by building the part with and without it).
  - **+ Add a detail** opens a form: pick the kind (holes, pocket, captive nut, bevelled edge…),
    fill in labelled boxes, each explained, with a diagram of what the sizes mean. The form writes
    the detail line, and **Change** opens a detail in the same form.
  - **Edit the details as text** shows the lines themselves (see below), to type or paste.
- **Automatic details:** listed with the part's details, marked "automatic", each with why it's
  there. **Change** puts a line of your own in its place; **Turn off** turns that kind off for the
  part (see [Automatic details](#automatic-details)).
- **Canted fins:** a canted fin set shows how fast it spins the rocket and how hard that pushes on
  the eggs (see [Fin cant, spin and apogee](#fin-cant-spin-and-apogee)).
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

Parts get their [automatic details](#automatic-details); `--no-auto` leaves them off. That writes
`out/my-rocket/`:
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
  - `round`: rounds the edge of its mouth with this radius (as a CAD fillet does), a lead-in for
    what goes in.
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
- **`@solid`** builds a nose cone or transition solid, shoulders included, although OpenRocket has
  it hollow.
- **`@screw-joint`** prints a body tube in two pieces that screw together, e.g. a fin section that
  unscrews from the tube above it: `@screw-joint at=105 from=aft`.
  - A threaded plug stands up from the aft piece and screws into a threaded collar inside the fore
    piece until the two tube ends meet, so the outside stays one smooth tube. The inside is
    narrower over the joint (about 7–8 mm less across); you're warned if a centering
    ring or motor tube is in the way, and it's an error if fins or a launch lug cross the split.
  - `at`: where the tube ends meet, from the end named by `from` (`fore` or `aft`; default `fore`).
  - `pitch` (default 3), `length` of thread engaged (default 5 turns), `depth` (default a third of
    the pitch) and `clearance` between the threads all round (default 0.3). The thread is
    right-handed, with 45° flanks, so both pieces print standing on their aft ends without supports.
  - `detent`: two small bumps on the plug click into dimples in the collar when it's screwed home
    (`on` by default; `detent=off` for none). `angle` turns them.
  - Each piece gets its own STL file ("(fore piece)" and "(aft piece)"), and its own part in the
    STEP files.
- **`@one-piece`** on a fin set prints the fins as part of the body tube they're on, in the tube's
  STL file, so there's nothing to glue or line up. Each fin's root reaches into the tube's wall
  (down to its inside surface, and only where the tube is) and is joined to it; canted fins come out
  at their angle. Fin tabs are left off. Printed fins on a printed tube get it by themselves (see
  below). With a screw joint, the fins go on the piece they're on.
- **Solid parts:** pockets and nut traps need a solid part. Tick **Filled** for the part in
  OpenRocket, and set its material to your infill density so the mass stays right, or write
  `@solid`. A filled part is built solid, shoulders included; OpenRocket's mass model still counts
  a filled part's shoulders as tubes with the shoulder thickness, so set that to the shoulder radius
  too.
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

## Automatic details

ork-cad adds some details by itself, worked out from what's in the design, so printed parts come
out ready to fly. They're worked out again every time (the `.ork` keeps only the lines you write),
and the website and the report give the reason for each.

- **Altimeter vents.** An altimeter works out its height from the air pressure, so the sealed space
  it's in needs small holes to the outside (static ports) to keep its air at the outside pressure.
  They go:
  - four in one ring, 90° apart. The American Rocketry Challenge handbook (Appendix 9) says four is
    best, never two, all the same size and evenly spaced in line around the tube, so wind from one
    side, or the rocket swinging, averages out;
  - sized for the air in the space. PerfectFlite's rule is one hole of 0.0016 × D² × L inches for a
    D × L inch bay (0.0016 × 4V/π for V cubic inches), or four holes of half that size. They're at
    least 0.02" (0.5 mm), the size the handbook gives for most ARC rockets; it warns that bigger
    holes add wind noise, and a spike when the rocket separates that can spoil the apogee reading;
  - on a straight, smooth part of the outside: a body tube, or the band of a transition that's the
    same size at both ends (in its middle), never a taper, where the airflow changes the pressure.
    Not where a shoulder or coupler is inside, 10 mm clear of joints, at least 4 body diameters
    behind the nose cone (PerfectFlite: well away from the nose cone shoulder), and as near the
    altimeter as that allows;
  - turned so nothing sticking out of the rocket ahead of them (launch lug, rail buttons) is in line
    with one, as the handbook asks, and after that away from the fins.

  None are added when the space already has vents of your own, and `@auto vents=off` keeps them off
  a part (they go to the next best place). Holes this small come out smaller, or closed, when
  printed running sideways: drill them out to size afterwards.
- **Printing solid.** A printed nose cone or transition that's hollow in OpenRocket, but whose
  material has an infill's density (under 800 kg/m³; solid PLA is 1240), is printed solid with that
  infill anyway, so ork-cad builds it solid (`@solid`) when the altimeter pocket or the eyebolt nut
  needs that. OpenRocket still works out its mass as hollow, so tick Filled there too. A hollow part
  of solid plastic is a thin wall on purpose and stays hollow.
- **Altimeter pocket.** When OpenRocket has the altimeter inside a printed nose cone or transition
  that's solid (ticked **Filled**, or printed solid as above). The altimeter is a mass component of
  type Altimeter, or one named "altimeter". The pocket is:
  - square, 1 mm wider than the altimeter's diameter, so a box-shaped altimeter fits;
  - 3 mm deeper than where the altimeter ends, and past the middle of a band so vents through the
    band open into it;
  - open at the end away from the motor's ejection charge, so the altimeter is sealed from the gas
    and comes out after each flight for the official reading;
  - rounded at its mouth (a fifth of its width, at most 4 mm) to guide the altimeter in.

  When the part stays hollow, it says to tick Filled instead.
- **Eyebolt nut.** When the shock cord sits next to an end of a printed nose cone or transition
  that's solid: a captive nut for an M4 eyebolt, 12 mm in from the end. The screw goes in
  along the axis, and the nut goes in through a slot in the side of the shoulder, which the tube
  covers once the rocket is together. The nut can't turn or fall out, so the eyebolt can't work
  loose.
- **Lead-ins.** The free end of each shoulder of a printed nose cone or transition, so it slides
  into its tube and centres itself. They go in by 5% of the shoulder's diameter, at most 4 mm (on a
  hollow shoulder, at most half its wall).
  - On the end the part is printed standing on (the wider one), a 30° chamfer blended in with a
    round, which needs no support. A thin hollow shoulder gets a plain 45° chamfer.
  - On the other end, a round.
- **Fins printed with their tube.** Printed fins (PLA, PETG...) on a printed body tube get
  `@one-piece`: one print, nothing to glue, and canted fins come out at exactly their angle. Not
  when the fins have tabs, which are for gluing into slots in the tube. OpenRocket's own
  "3D printable nose cone and fins" example asks for its fin can to be exported this way. The
  report counts the file's plastic at the tube's material; OpenRocket still uses the fins' own for
  them.

A line of the same kind written in the part's comment takes the place of the automatic one
(`@chamfer` and `@round` for each end on its own). `@auto off` turns them all off for that part,
or one kind at a time: `@auto vents=off`, `solid=off`, `pocket=off`, `nut-trap=off`, `edges=off`,
`one-piece=off` (on the fin set: the fins are printed on their own). When
comparing with a CAD file, the changes include `@auto off`, so the part comes out just like the
file.

**Sealed spaces.** The export lists the rocket's sealed spaces, nose to tail. For each one it shows:
- where the space starts and ends (the caps, bulkheads and centering rings around it);
- what's inside it;
- whether the motor's ejection charge fires into it;
- which holes open into it;
- its air volume and inside diameter, which altimeter vent-size charts ask for.

It warns when:
- the altimeter's space has no vent holes;
- ejection gas could reach the altimeter or the eggs.

## Fin cant, spin and apogee

Canted fins (each turned a few degrees about its root, set as **Fin cant** in OpenRocket) are
built at their angle, turned about the middle of the root as OpenRocket does, with the root cut to
follow the tube's curve so it sits flush.

**What cant does.** The tilted fins push the rocket round. As it spins faster, each fin meets the
air at a smaller angle, until the push and the drag of the spinning cancel: the rocket settles at a
spin that goes up with its speed (twice as fast, twice the spin). Once it spins, each fin meets the
air almost straight on, so cant adds next to no drag, and the energy that goes into the spin is a
fraction of a percent of the flight's. **So cant hardly changes the apogee**, and it can't be used
to set it: in OpenRocket, canting an ARC rocket's fins 10° changes its apogee by under a metre (and
raises it slightly, as the spin averages out the wind's push). What cant does is spin the rocket,
which evens out small differences between the fins and in the motor's thrust, and pushes everything
in the rocket outward: the side of an egg 22 mm from the axis is pushed with about 1 g at a typical
ARC rocket's 3 turns a second (2° of cant), 5 g at 5°, 20 g at 10°. To set the apogee, change the
nose weight.

**On the website**, a canted fin set shows how fast it spins the rocket and the push on an egg, at
the top speed of the simulations saved in the `.ork`. It's worked out with OpenRocket's own roll
formulas (`src/aero/roll.ts`), which agree with OpenRocket's simulations to within 2%.

**From the command line**, ork-cad runs OpenRocket's own simulator on the design (OpenRocket must
be installed; set `OPENROCKET_HOME` if it isn't in `C:\Program Files\OpenRocket`):

```
npm run flight -- my-rocket.ork                            every simulation's apogee as it is
npm run flight -- my-rocket.ork --target 250               the nose weight for a 250 m apogee
npm run flight -- my-rocket.ork --target 820ft --write my-rocket-tuned.ork
npm run flight -- my-rocket.ork --cant 0,1,2,5             apogee, spin and egg push at each cant
npm run flight -- my-rocket.ork --target 250 --cant        the cant for 250 m, if any can reach it
```

- `--target` finds the mass of the nose weight (the mass component called "ballast" or "weight", or
  the one named with `--mass "<name>"`) that gives that apogee in OpenRocket, to 0.05 m. It shows
  how much each gram changes the apogee, the lift-off mass, and the apogee with that weight in each
  of the design's other simulations (other temperatures, winds or delays). `--write` saves a copy of
  the design with the new mass.
- `--sim` picks the simulation: its number in OpenRocket's list, or part of its name (default the
  first). Each flight uses the simulation's own random seed, so the same design always gives the
  same answer.
- `--cant` lists, for each angle, the apogee and the fastest spin OpenRocket simulates, and the push
  on an egg (`--egg 25` for 25 mm from the axis). With `--target`, it looks for the cant between 0°
  and 15° that gives that apogee, and says so when none does (nearly always).

## What it builds

| OpenRocket part | Built as |
|---|---|
| Nose cones, transitions (conical, ogive, ellipsoid, power, parabolic, Haack; clipped or not) | Revolved solid. Cone, ellipsoid and ogive outsides are exact lines, ellipses and circular arcs (arcs as their exact rational B-spline); the other shapes and curved insides are B-splines within 0.00001 mm of the formula |
| Wall thickness | Measured perpendicular to the surface, as OpenRocket's mass model intends, so the wall is even all the way to the tip |
| Shoulders | Tube with a cap as thick as its wall when "capped" is ticked |
| Body tubes, inner tubes, couplers, centering rings, bulkheads, engine blocks, launch lugs | Exact tubes/discs |
| Trapezoidal, elliptical (true ellipse) and freeform fins, fin tabs | Exact outline, extruded to the fin thickness; canted fins turned by their cant, the root cut to the tube's curve |
| Rail buttons | Same shape as OpenRocket's (base, neck, flange, optional screw head) |
| Mass components, parachutes, shock cords | Nothing (no printable shape) |

Sizes set to "auto" in OpenRocket are worked out the way OpenRocket 24.12 does: radii from the
neighbouring body parts (across stages too), rings and bulkheads from the tube they sit in, and
packed parachutes from their tube, keeping their packed volume.

Fin tabs go where OpenRocket 24.12 puts them when it opens the file, except on elliptical fins.
There OpenRocket places the tab as if the fin were 50 mm long, so it shows the tab in the wrong place
(an 80 mm fin's middle tab 15 mm too far forward), and every time the file is opened and saved, the
tab moves again by the same amount. ork-cad builds the tab where the saved position puts it, and if
that sticks out of the fin, moves it back one opening at a time until it fits: where it was
designed. A note says what it did. Measuring the tab's position from the fin's front (top) in
OpenRocket stops it moving.

Not supported yet (those parts are listed as not built, with the reason): pods and side boosters,
motor clusters, flipped nose cones (tail cones), fins on a nose cone or transition,
tube fins. Rounded or airfoil fin edges are built square for now, and fin fillets aren't built yet
(it says so when a design has them). Shoulders with 0 mm walls are left out, since they can't be
printed. A shoulder narrower than the inside of the part it's on doesn't touch the wall, so it comes
out as a separate piece (with a note).

## How it's checked

`npm test` runs these checks on four of the example rockets that come with OpenRocket 24.12, on
a test rocket with one fin set for each way OpenRocket places a fin tab, the same rocket with each
fin set canted (−10° to 15°), and on a small ARC-style
rocket with a printed transition holding the altimeter (all in `test/fixtures/`), and on any
designs of your own in `test/private/fixtures/`, a folder git ignores.

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
- **Canted fins:** every vertex of OpenRocket's OBJ export outside the tube lies on our canted fins
  (within 0.001 mm), so the angle, the direction and the point they turn about are OpenRocket's.
  OpenRocket lowers only the middle line of a canted root onto the tube, so its root corners dip into
  the tube (by at most what ours reaches down), and its mass model is 0.1–1.8% off our exact solid.
- **Fins printed with the tube:** the tube with its fins joined on has exactly the volume of the
  tube, the fins and the sliver between each flat root and the tube's curve (worked out by hand);
  canted, exactly the tube and the canted fins; with a screw joint, they go on the right piece.
- **Spin:** the spin worked out for canted fins agrees with OpenRocket's own simulations of two of
  its examples to within 2%, and goes with the speed and the cant as it should.
- **Plain words:** every kind of detail and part is described; a detail shown in 3D is exactly the
  plastic it changes (three holes through the nose cone: their volume to within the mesh); the form
  writes lines that read back without errors for every kind, keeping settings it has no box for.
- **Tuning:** the search for a target apogee (`src/flight/solve.ts`) finds it in a few flights,
  stays in range, and says when it can't be reached.
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
  - Pockets (with sharp, rounded and rounded-mouth openings), a rounded rim, rounded lead-in
    chamfers (given by length or by inset) and a captive nut (with its slot and screw hole) cut
    into the ARC example's solid balsa nose cone each remove exactly the volume worked out by hand,
    and vents open into the pocket.
  - Mistakes in detail lines are refused with a reason.
- **Comparing with CAD files:** parts built with known changes (a longer, narrower shoulder with a
  rounded lead-in, side holes through a curved wall, pockets, a nut trap, a rounded rim, Filled),
  written as STEP and as STL, moved, turned, tilted and in inches, compared with the design: each
  time it finds exactly those changes again, the part built with them matches the file, and the
  design written with them builds the same part.
- **Automatic details:** the ARC-style test rocket gets exactly the pocket, vents, eyebolt nut and
  lead-ins worked out by hand. Its altimeter's space holds the air worked out by hand; the vents are
  sized from that by PerfectFlite's rule, sit in the middle of the band, turn away from the launch
  lug and, built, open into the pocket; the pocket's rounded mouth removes exactly the volume worked
  out by hand. `@auto` lines and lines of your own turn them off or take their place. A hollow
  transition at an infill's density is built solid, the same as ticking Filled; one of solid plastic
  gets lead-ins sized for its wall and a note to tick Filled.
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
`tools/openrocket-ref/build/RefExport.class` and `Flight.class` (which runs OpenRocket's
simulations for `npm run flight`) are precompiled. To rebuild them, compile with the Eclipse
compiler, which runs on OpenRocket's Java 17:

```
"%OPENROCKET_HOME%\jre\bin\java" -jar ecj-3.38.0.jar -17 -cp "%OPENROCKET_HOME%\jar\OpenRocket-24.12.jar" -d tools/openrocket-ref/build tools/openrocket-ref/RefExport.java tools/openrocket-ref/Flight.java
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
- `src/features/`: reads the `@` detail lines (`parse.ts`, screw sizes in `hardware.ts`), works
  out the automatic ones (`auto.ts`), and cuts them (`holes.ts`, `cuts.ts`; `apply.ts` runs them
  all).
- `src/checks/compartments.ts`: the sealed spaces and the vent checks.
- `src/ork/write.ts`: writes a component comment back into an `.ork`.
- `src/export/files.ts`, `report.ts`: write the STL and STEP files and the report
  (`src/geometry/stl.ts` reads and writes STL).
- `src/match/`: comparing a part with a CAD file: reading it and finding its axis and outline
  (`cad.ts`), working out the changes and checking them (`compare.ts`), and surface distances
  (`distance.ts`).
- `src/aero/roll.ts`: the spin canted fins give, with OpenRocket's roll formulas.
- `src/node/openrocket.ts`, `tools/openrocket-ref/Flight.java`: run OpenRocket's own simulations
  from Node; `src/flight/solve.ts` finds the setting for a target apogee.
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
