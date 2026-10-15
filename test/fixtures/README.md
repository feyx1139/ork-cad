# Test rockets

Four of these are example designs that come with OpenRocket 24.12, copied
unchanged from `datafiles/examples/` in OpenRocket's jar. OpenRocket and its examples are free
software under the GNU GPL v3 (https://openrocket.info).

| File | OpenRocket example |
|---|---|
| `3d-printable-nose-cone-and-fins.ork` | 3D printable nose cone and fins |
| `arc-payload-rocket.ork` | ARC payload rocket |
| `base-drag-hack.ork` | Base drag hack (short-wide) |
| `dual-parachute-deployment.ork` | Dual parachute deployment |

`fin-tabs.ork` was written for these tests: a body tube with eight fin sets, one for each way
OpenRocket places a fin tab when it opens a file (trapezoidal, elliptical and freeform fins; tabs
measured from the front, middle or bottom; fins shorter than OpenRocket's 50 mm default).
`canted-fins.ork` is the same rocket with each fin set canted (5°, −3°, 8°, 2°, −10°, 15°, 4° and
−6°), for canted fins.

Each `.openrocket.json` and `.openrocket.obj` next to them is what OpenRocket itself computes for
that design (positions, lengths, volumes, masses) and its OBJ export, made with
`npm run reference` (see the main README).

`details/printed-transition.ork` was also written for these tests: a small ARC-style rocket with a
printed, solid transition band holding the altimeter, for the automatic details. It sits in its own
folder because it isn't one of the rockets checked against OpenRocket's own numbers.
