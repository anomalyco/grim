# The wall

The landing page's background is a thick off-white wall, and something behind it wants out. About 30 s after page
load it punches the wall from behind: four punches, alternating between two sites (B, A, B, A), 5–8 s apart, each
stronger than the last. Each punch is one hard, discrete knock. The fracture cracks out from the impact, the crack
front spreading, with long cracks running on past it. Plates tip up toward you about one of their edges: one or two
by 10–15° on the first punches, two or three by 20–30° on the third, some popping partly free later on. Crumbs fly,
and the page jolts a pixel or a few, sharply. Nothing bends, ripples or settles: the
plates only rotate and move, rigidly. Site B ends heavily cracked and lifted, and holds. The fourth punch breaks
through at A. Its lifted plates and everything near the impact break free and fall in 3D, tumbling toward you with
their broken sides showing and their shadows on the wall, off the bottom of the window. That opens a big black cavity
right away, behind a rim showing the wall's thickness. One quick punch widens it to a large ragged hole with a broken,
partly lifted rim. A few seconds later a monster climbs out of the dark (the Knuckler: a rigged, cel-shaded 3D
creature with huge clawed hands and a pale mask of a face), grips the rim, hauls itself onto the page and crawls off it.
Then more and more come, faster and faster, into a steady stream. You can stab them with your pencil: three stabs kill
one. One bloody claw
scratch appears during the punching, a moment after the second or third punch; none come with the monsters. Everything runs in the
browser and starts from scratch on every load.

It's drawn as a stylised 3D scene, not a photo. One key light from the top left gives flat, banded (cel) shading per
face. Ink lines mark the silhouettes and crack edges, as with the pencils. Lifted things cast soft drop shadows. The
untouched wall, face-on, is exactly the page's paper colour (`#fcfcfb`).

Query parameters:
- `?wall=off` turns it off (to compare).
- `?wall=debug` shows a panel with Punch A, Punch B, Break through, Widen, Blood scratch, Spawn crawler, Flood and
  Reset, a 1×–20× clock and the phase.
- `&auto=off` (with debug) holds the schedule: only the buttons do anything.
- `&clock=manual` stops the clock: `window.wallStep(frames, fps = 30)` advances it, for frame-exact captures.

It's off with `prefers-reduced-motion` (no jolt and no monsters either: the page is plain paper; `?wall=debug` shows it
anyway) and without WebGL2.

## How it's drawn

The renderer (`scene.ts`) is hand-written WebGL2, with no three.js. The wall's lazily loaded chunk, blood included, is
about 45 KB minified (18 KB gzipped). The monsters are three.js, in a chunk of their own (about 645 KB minified, 166 KB
gzipped) that loads at the breakthrough, with their model (`knuckler.glb`, 484 KB, 258 KB gzipped). It draws one full-window canvas behind the page. Everything is in page px with z toward you, and the
wall's face is z = 0. The camera faces the wall, near-orthographic (a perspective from `MATERIAL.distance`, 2200 px, so
falling pieces grow a little as they come at you). The view is also very slightly oblique (`MATERIAL.oblique`): a
point z px toward you shifts by z × (−0.15, −0.23). The wall's face still lands exactly on the page, but anything
raised shows its lower right sides, and gaps and the hole show the wall's depth. That's what makes a lifted plate read
as a slab, not a grey patch.

Each frame something moves, the pieces refill three streams:
- **faces**: flat-shaded triangles, depth-tested. The colour is banded by the face's normal against the key light
  (`MATERIAL.bands`; the wall's own facing maps to exactly the paper colour).
- **shadows**: everything lifted, flattened onto the wall along the light, into a half-res buffer (quarter on phones).
  It holds coverage (blurred) and the caster's height (spread by a max filter). Each face darkens where something
  more than a few px above it is between it and the light. That way lifted plates shadow each other and the wall,
  but not themselves. The bare wall gets the same in a background-only pass.
- **ink**: screen-space lines with an antialiased edge, depth-tested with a small bias, so hidden edges stay hidden.

It only redraws when something moves or the page scrolls, and a hidden tab gets no frames at all.

## The pieces

Each is its own module with its parameters in one object at the top. Change a number, save; the preview rebuilds.

| Module | What it does | Parameters |
| --- | --- | --- |
| `material.ts` | The look: paper, the broken inside (`core`), the dark, ink, the wall's thickness, the key light, the bands, the oblique view, the camera distance, ink widths, crack gaps, shadow strength/colour/blur. | `MATERIAL` |
| `scene.ts` | The WebGL2 renderer (above). | – |
| `cracks.ts` | The fracture round a site, in advance: an irregular Voronoi tiling, with small plates near the impact and bigger further out, and three meeting at the impact. Each shared edge is one jagged polyline, so plates fit exactly. Edges on the outside of the fractured area never crack. Each crack runs along its edge in 70 ms. | `CRACK`: radius, spacing near/far, jag, bend, zip |
| `plates.ts` | The plates as rigid slabs (face, broken sides, back), drawn with ink on the face's outline, the back edge and down the corners. A plate free on all sides but its hinge (the outside of the fractured area, or the side facing away from the impact) tips about it, and pops out of the wall a little, snapping there in 70 ms with no overshoot, once the crack front reaches it. | `PLATE`: max degrees, rim tilt, pop, snap |
| `punches.ts` | A punch site. Each punch, as strong as its row in `TIMELINE.punches`, cracks every edge out to its reach, the front spreading out at 1600 px/s, plus a few long cracks running on. It lifts free plates (fresh ones first, preferring those whose free sides border flat plates so their thickness shows, plus one already up), some popping partly free, and throws crumbs and chunks. It draws its plates, its cracks (ink with a dark gap), the crack walls of flat plates seen down a gap, and the dark behind anything lifted. It also picks the plates for the breakthrough (everything lifted and everything within 55% of the radius) and the widening, and tips up a plate or two on the rim after a widening. | `PUNCH`: run length, spread, how far popping free goes, break reach, shock |
| `debris.ts` | Rigid bodies: knocked-out plates (they leave from where they were tipped to, toward you, keep tipping the same way, tumble under gravity with their shadow on the wall, and are gone below the window) and the crumbs each punch spits. | `DEBRIS`: gravity, speeds, spin, shadow fade, crumbs, max |
| `hole.ts` | The opening: the dark behind the knocked-out plates, and the rim. The break narrows going in (a punch from behind shears out a cone), so the rim's inside faces show from the front, banded by the key light: lit at the bottom right, dark at the top left. Ink on the edge and where the rim meets the dark. | `HOLE`: slope, vary, jag, smooth, shade |
| `blood.ts` | One bloody claw scratch, ever (the debug panel's button adds more, for testing): a three-line rake swiped in 120–250 ms, wet and glossy, dripping after 0.5–1 s. It comes 0.8–2 s after punch 2 or 3, before the breakthrough, and none come with the monsters. It lands at a random spot on the visible screen: clear of the header, the note and the button, the hole and both punch sites, with room below for drips. | `BLOOD`: `total`, `afterPunch`, `delay`, placement (margin, top, dripRoom, apart, avoid), stroke shape, swipe time, colours, splatter, drips (delay, count, size, gather, speed, run, stick) |
| `monsters.ts` | The monsters, in three.js on their own canvas, loaded at the breakthrough (or when the panel asks for one). See below. | `MONSTER`: how many at once (14, 5 on phones), size (fitted to the hole, 55–85 px a model unit), crawl speed, scuttling, pauses, pixel ratio, ink, shadow, and stabbing: hits to kill (3), hit slack, flinch, turn, dying, fading, blood |
| `../stab.ts` | Between the monsters and your pencil (`../doodle`): whether your pencil is over a monster, and a stab. | – |
| `timeline.ts` | The director: when each step happens, all in `TIMELINE`. And the debug panel (with the live count of monsters and kills). The clock scale speeds up the schedule, not the animations. | `TIMELINE`: the first punch (30 s), the order (`"babA"`: the capital breaks through), the gap between punches (5–8 s), each punch's strength (`punches`: reach, runs, lifts, tilt, popping free, crumbs, chunks, jolt), the widening (when, how many pieces, how far out), when the monsters start, and the stream's spawn curve |
| `index.ts` | Wires it up: the canvas, the frame loop, the jolt (its size per punch in `TIMELINE.punches`: straight out and straight back in 80 ms, on the wall and the page's content together), the knock-out queue, the pointer. `SITES` places the two punch sites and gives each its character. | `SITES` |
| `core.ts` | Shared: the view, random helpers, WebGL helpers, a growable float buffer, rotations, triangulation. | – |

Layering:
- `.wall-gl` (fixed, z-index 0) is behind the page's content and the pencils' ink. Everything above is on it.
- `.wall-blood` sits on the wall, under the text.
- `.wall-crawlers` (z-index 25, the monsters' canvas) is over the content and under the pencils. It never takes the
  pointer: a press on a monster is caught on the window first (and then goes nowhere else: no ink, no link).
- The note and footer have their own backgrounds.

Phones (coarse pointer or a small screen): device pixel ratio up to 1.5, quarter-res shadows, smaller fractures (site
B smaller still), at most 5 monsters, drawn at pixel ratio 1.

## The monsters

The Knuckler was designed separately (website/artifacts/grim-monster/astra: its look, rig and clips). Here:

- **The model:** `knuckler.glb`, made from that artifact's `monster.glb` by `scripts/landing-monster-glb.mjs` (the
  meshes its look hides and its vertex colours dropped, the body simplified to 30%, the clips resampled, meshopt). It's
  imported as a file, so the build puts it in `dist/` under a content-hashed name. Meshopt quantizes positions, which
  for a skinned mesh folds the dequantizing transform into the inverse bind matrices; `dequantize` undoes that on
  load, because the look reads bind-space positions (the face's paint, the feet).
- **The look:** that artifact's `cel-look.js`, ported: flat paint by surface, three bands from one key light, a mask of
  a face, faint grain, skinned inverted-hull ink. Everything at depth in the hole goes down into the dark. One set of
  materials and geometry for all of them (each has its own skeleton and mixer; `SkeletonUtils.clone`). A dying one gets
  its own see-through copies to fade.
- **In the same drawing as the wall:** the camera is the wall's (page px, near-orthographic from MATERIAL.distance,
  the same oblique tilt, jolted with the page), and so is the light. No shadow maps: a soft blob under each, pushed
  away from the light by its height.
- **Behind the wall:** a depth-only copy of the wall (its face with the opening cut out, and the opening's rim)
  hides whatever's still behind it, so a monster is only seen through the opening until it's climbed out. Nothing
  fades in.
- **Coming out:** the clips were made against a stand-in wall: its hole at (−1.2, −0.23), the rim the creature climbs
  over 1.24 units out along +X, 0.28 units thick, +Z toward you, the creature crawling along +X with the wall its floor.
  Each monster maps that onto our hole: scaled to page px, turned to the way it'll go (random, clear of the others
  climbing), and moved so that rim lands on our rim that way. It plays `Emerge_Climb`, then crawls off that way
  (`Crawl_Deliberate`, or `Crawl_Scuttle` for some), now and then stopping to twitch (`Idle_Twitch`). The crawl clips
  move their root: each completed cycle, the monster moves on by the clip's stride, so the feet stay planted. Between
  clips it's moved so its body stays where it was. Gone 160 px past the window's edge.
- **The stream:** TIMELINE's pour (the first 3 s after the opening, then every 6 s, each gap 0.8 times the last, down
  to 0.8 s), up to MONSTER.max at once.
- **Stabbing:** each frame, the pointer is tested against each monster's body (a chain of fat segments through its
  head, neck, spine and pelvis, and its hands and joints, as seen). Over one, your pencil takes a tip-down stabbing grip
  and the monster's ink thickens and reddens. A press there is a stab, and only that: the pencil stabs (back, thrust
  in with a squash, out, in 230 ms), blood spurts (`Blood.spurt`: a small splat, droplets, a drip or two, fading after
  9 s), and the monster jerks back, hisses (`Idle_Twitch`) and turns away. The third stab kills it: it curls up against
  the wall, twitching, and fades away over a second. Phones: tap one.

## Iterating

- **One site at a time:** `?wall=debug&auto=off`, then press Punch A (or B) and watch each punch. Then press Break
  through and Widen. Reset starts over with a new fracture.
- **The pacing:** edit `TIMELINE`, then watch the whole run at 1× (it's about 50–60 s to the first monster) or faster.
- **How it breaks:** `CRACK` shapes the pattern, `PUNCH` decides where cracks go and which plate lifts, and `PLATE`
  sets how far plates tip. `MATERIAL.oblique` and `MATERIAL.bands` decide how 3D it reads.
- **Captures:** with `?wall=debug&clock=manual`, call `wallStep(1)` and screenshot per frame (Playwright), then
  `ffmpeg -framerate 30`. Headless Chromium renders WebGL in software, far slower than a laptop, which is why the
  clock can be stepped. Playwright's full Chromium build (`channel: "chromium"`) is faster than its headless shell.
