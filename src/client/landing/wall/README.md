# The wall

The landing page's background is a thick off-white wall, and something behind it wants out. From about 15 s after
page load, it punches the wall from behind in two places, over about 20 seconds, to an irregular beat. Each punch is
one hard, discrete knock. One or two new cracks run out along a fracture worked out in advance. One plate cracked
free tips up a few degrees more about one of its edges, toward you, and pops out a little. Crumbs spit out and fall,
and the page jolts a pixel or two. Nothing bends, ripples or settles: the plates only rotate and move, rigidly. Site B
cracks, lifts a few plates and stops. Site A keeps going until the breakthrough. Its lifted plates break free and
fall in 3D, tumbling toward you with their broken sides showing and their shadows on the wall, off the bottom of the
window. That opens a black cavity behind a rim showing the wall's thickness. A few more punches knock out more plates
until it's a large ragged hole. Then things with big hands and wrong faces crawl out and off the page. Three bloody
claw scratches appear along the way. Everything runs in the browser and starts from scratch on every load.

It's drawn as a stylised 3D scene, not a photo. One key light from the top left gives flat, banded (cel) shading per
face. Ink lines mark the silhouettes and crack edges, as with the pencils. Lifted things cast soft drop shadows. The
untouched wall, face-on, is exactly the page's paper colour (`#fcfcfb`).

Query parameters:
- `?wall=off` turns it off (to compare).
- `?wall=debug` shows a panel with Punch A, Punch B, Break through, Widen, Blood scratch, Spawn crawler, Flood and
  Reset, a 1×–20× clock and the phase.
- `&auto=off` (with debug) holds the schedule: only the buttons do anything.
- `&clock=manual` stops the clock: `window.wallStep(frames, fps = 30)` advances it, for frame-exact captures.

It's off with `prefers-reduced-motion` (no jolt and no crawlers either: the page is plain paper; `?wall=debug` shows it
anyway) and without WebGL2.

## How it's drawn

The renderer (`scene.ts`) is hand-written WebGL2, with no three.js. The wall's lazily loaded chunk, crawlers and
blood included, is about 55 KB minified (21 KB gzipped). It draws one full-window canvas behind the page. Everything is in page px with z toward you, and the
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
| `plates.ts` | The plates as rigid slabs (face, broken sides, back), drawn with ink on the face's outline, the back edge and down the corners. A plate free on all sides but its hinge (the outside of the fractured area, or the side facing away from the impact) tips about it. Each knock adds 5–8° and pops it 2–4 px out, snapping there in 70 ms with no overshoot, up to 16–25° and 7–13 px. | `PLATE`: first/step/max degrees, pop, snap |
| `punches.ts` | A punch site. Each punch makes one or two cracks run out (plus one more that frees a plate if none is free), lifts one plate (a new one, preferring those with flat neighbours so their thickness shows, or one already up), and spits crumbs. It draws its plates, its cracks (ink with a slight dark gap), the crack walls of flat plates seen down a gap, and the dark behind anything lifted. It also picks the plates for the breakthrough and the widening, and tips up a plate or two on the rim after a widening. | `PUNCH`: cracks per punch, reach, carry, wander, again |
| `debris.ts` | Rigid bodies: knocked-out plates (they leave from where they were tipped to, toward you, keep tipping the same way, tumble under gravity with their shadow on the wall, and are gone below the window) and the crumbs each punch spits. | `DEBRIS`: gravity, speeds, spin, shadow fade, crumbs, max |
| `hole.ts` | The opening: the dark behind the knocked-out plates, and the rim. The break narrows going in (a punch from behind shears out a cone), so the rim's inside faces show from the front, banded by the key light: lit at the bottom right, dark at the top left. Ink on the edge and where the rim meets the dark. | `HOLE`: slope, vary, jag, smooth, shade |
| `blood.ts` | Three bloody claw scratches, ever. Each is a three-line rake swiped in 120–250 ms, wet and glossy, dripping after 0.5–1 s. One comes while the wall's being punched. Two more come, one at a time, within about 5 s of the first crawler. Each lands at a random spot on the visible screen: clear of the header, the note and the button, the hole and both punch sites, with room below for drips, and spread apart from the others. | `BLOOD` |
| `crawlers.ts` | Things coming out of the hole and crawling off the page (being redesigned separately). They clip to `Fracture.removed`. | `CRAWLER` |
| `timeline.ts` | The director: when each step happens, all in `TIMELINE`. And the debug panel. The clock scale speeds up the schedule, not the animations. | `TIMELINE`: when the punching starts, B's delay, punch gaps (irregular, doubles, escalating), punches per site, the breakthrough delay, widening punches/gaps/pieces/reach, when the crawlers start, and the stream's spawn curve |
| `index.ts` | Wires it up: the canvas, the frame loop, the jolt (straight out and straight back in 60 ms, on the wall and the page's content together), the knock-out queue, the pointer. `SITES` places the two punch sites and gives each its character. | `SITES` |
| `core.ts` | Shared: the view, random helpers, WebGL helpers, a growable float buffer, rotations, triangulation. | – |

Layering:
- `.wall-gl` (fixed, z-index 0) is behind the page's content and the pencils' ink. Everything above is on it.
- `.wall-blood` sits on the wall, under the text.
- `.wall-crawlers` (z-index 25) is over the content and under the pencils.
- The note and footer have their own backgrounds.

Phones (coarse pointer or a small screen): device pixel ratio up to 1.5, quarter-res shadows, smaller fractures (site
B smaller still), fewer crawlers.

## Iterating

- **One site at a time:** `?wall=debug&auto=off`, then press Punch A (or B) again and again and watch: two cracks on
  the first punch, a plate lifting from the second. Then press Break through and Widen. Reset starts over with a new
  fracture.
- **The pacing:** edit `TIMELINE`, then watch the whole run at 1× (it's about 45 s to the first crawler) or faster.
- **How it breaks:** `CRACK` shapes the pattern, `PUNCH` decides where cracks go and which plate lifts, and `PLATE`
  sets how far plates tip. `MATERIAL.oblique` and `MATERIAL.bands` decide how 3D it reads.
- **Captures:** with `?wall=debug&clock=manual`, call `wallStep(1)` and screenshot per frame (Playwright), then
  `ffmpeg -framerate 30`. Headless Chromium renders WebGL in software, far slower than a laptop, which is why the
  clock can be stepped. Playwright's full Chromium build (`channel: "chromium"`) is faster than its headless shell.
