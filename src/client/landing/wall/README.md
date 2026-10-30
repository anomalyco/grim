# The wall

The landing page's background is a painted drywall wall, and something behind it wants out. From about 15 s after
page load, it punches the wall from behind in two places. Each punch bulges the board out toward you, a little deeper
every time. Cracks radiate from each bulge and concentric fractures join them. The plates between start lifting and
jolting with each punch, and dust and crumbs puff out. After about 20 s, site A breaks through: the lifted plates are
knocked out and fall toward you, the hole opens onto the dark, and it widens over a few more punches. Site B stays
cracked and lifted, frozen. Then things with big hands and wrong faces crawl out and off the page. Three bloody claw
scratches appear along the way. Everything runs in the browser and starts from scratch on every load.

Query parameters:
- `?wall=off` turns it off (to compare).
- `?wall=debug` shows a panel: a button per step, a 1×–20× clock, and the phase.
- `&auto=off` (with debug) holds the schedule: only the buttons do anything.
- `&clock=manual` stops the clock: `window.wallStep(frames, fps = 30)` advances it, for frame-exact captures.

It's off with `prefers-reduced-motion` (no shake, no crawlers, no bulges either: the page is plain paper;
`?wall=debug` shows it anyway) and without WebGL2.

## The pieces

Each is its own module with its parameters in one object at the top. Change a number, save; the preview rebuilds.

| Module | What it does | Parameters |
| --- | --- | --- |
| `material.ts` | The wall: a full-window WebGL pass shading a height field (page px, over the hero) under a key light from the top left, matte (barely any sheen). Flat, it's exactly the paper colour plus a faint light falloff and paint grain. Also the flex waves and the page shake. | `MATERIAL`: cell size, light, diffuse/brighten/specular, occlusion, relief, sheen, grain, wave speed/length/decay, flex, shake |
| `punches.ts` | A punch site. Each punch adds a soft, wide bulge with a firmer middle (stamped into the height field with an overshoot and settle), a flex wave and a shake. It then advances the cracks, lifts the plates that are free, jolts them, and puffs dust and crumbs out of the cracks. It also picks the plates for the breakthrough and the widening. | `PUNCH`: bulge per punch and max, width, core, aim, knock timing, wave, shake, which punch cracks start on (`cracksFrom`), concentric cracks (`ringsFrom`, `ringChance`), lifting (`liftFrom`, `liftStep`), dust |
| `cracks.ts` | The radial fracture round a site: radial cracks, some stopping short so outer plates are bigger, crossed by broken concentric arcs. Every edge is jagged and shared by both neighbours, and radial cracks have short branches. Each punch drives the radial cracks a ring further out, and later ones crack some of the arcs. Cracks are shadowed grooves with a lit lip, opening where a plate lifts away. | `CRACK`: radius, radial count, where they stop, ring radii and jitter, angle jitter, which arcs ever crack (`ringFate`), merge limit, jaggedness, branches, crack speed, width/darkness/age, gap |
| `plates.ts` | Plates cracked free on all sides but their outer edge tip up toward you, hinged on that edge. They're bent, not flat. Each is drawn as a slab: painted face shaded corner by corner in the key light plus a fill light, the broken gypsum thickness on the raised edges, a torn paint lip, and a soft cast shadow on the wall below right. Punches jolt them on springs. | `PLATE`: tilt per ring, lift per ring, bend, fill light, push, thickness, perspective distance, gypsum colours, paint lip, shadow, spring/damping/jolt |
| `dust.ts` | Puffs of gypsum dust that bloom, drift and settle, and crumbs that spit out toward you, tumble and fall. | `DUST`: puff size/growth/life/alpha/drift, crumb size/speeds, gravity, caps |
| `debris.ts` | A plate knocked out at the breakthrough: it keeps tipping the way it was lifting, comes toward you, tumbles (its gypsum edge showing), falls with its shadow sliding on the wall, bounces at the bottom of the window and fades. Chips go with it. | `DEBRIS`: gravity, push/out/up, spin, tip, perspective, thickness, gypsum, bounce, linger/fade, shadow, chips, max |
| `hole.ts` | The opening, drawn into the stencil twice: as it is, and as the board's far side (pulled toward the window's middle, so the broken gypsum thickness shows and shifts as you scroll). Through both: the dark, with a vignette, a slow stir, and something huge passing. Along the outline: a bright lip and a dark seam. | `HOLE`: depth, tilt, dark colours, stir, passing, edge shades, gypsum, lip, seam, bulge |
| `blood.ts` | Three bloody claw scratches, ever. Each is a three-line rake swiped in 120–250 ms, wet and glossy, dripping after 0.5–1 s. One comes while the wall's being punched. Two more come, one at a time, within about 5 s of the first crawler. Each lands at a random spot on the visible screen: clear of the header, the note and the button, the hole and both punch sites, with room below for drips, and spread apart from the others. | `BLOOD`: `total`, `first`, `after`, `afterWithin`, placement (margin, top, dripRoom, apart, avoid), stroke shape, swipe time, colours, splatter, drips (delay, count, size, gather, speed, run, stick) |
| `crawlers.ts` | Things coming out of the hole and crawling off the page (being redesigned separately). | `CRAWLER` |
| `timeline.ts` | The director: when each step happens, all in `TIMELINE`. And the debug panel. The clock scale speeds up the schedule, not the animations. | `TIMELINE`: when the punching starts, B's delay, punch gaps (irregular, doubles, escalating), punches per site, the breakthrough delay, widening punches/gaps/pieces, when the crawlers start, and the stream's spawn curve |
| `index.ts` | Wires it up: the canvases, the frame loop (draws only when something moves; a hidden tab gets no frames, so the clock stops), resizing, the shake, the pointer. `SITES` places the two punch sites and gives each its character. | `SITES` |
| `core.ts` | Shared: the view, random helpers, WebGL helpers, the batched coloured-triangles program (lines, fills, per-corner colours, soft discs), and triangulation. | – |

Layering:
- `.wall-gl` (fixed, z-index 0) is behind the page's content and the pencils' ink. The bulges, cracks, plates, dust, debris and hole are on it.
- `.wall-blood` sits on the wall, under the text.
- `.wall-crawlers` (z-index 25) is over the content and under the pencils.
- The note and footer have their own backgrounds.

Phones (coarse pointer or a small screen): a coarser height field, device pixel ratio 1, smaller fractures (site B
smaller still), fewer crawlers.

## Iterating

- **One site at a time:** `?wall=debug&auto=off`, then press "Punch site A" (or B) again and again and watch the
  stages: bulge (from the first punch), cracks (punch 3), concentric cracks (5), lifting (6). Then press "Break
  through" and "Open hole". Reset starts over with a new fracture.
- **The pacing:** edit `TIMELINE`, then watch the whole run at 1× (it's about 45 s to the first crawler) or faster.
- **How it breaks:** `CRACK` shapes the pattern (more radials, more rings, more stopping short). `PUNCH` decides how
  many punches each stage takes. `PLATE` sets how far plates tip and how they're lit.
- **Captures:** with `?wall=debug&clock=manual`, call `wallStep(1)` and screenshot per frame (Playwright), then
  `ffmpeg -framerate 30`. Headless Chromium renders WebGL in software, far slower than a laptop, which is why the
  clock can be stepped. Playwright's full Chromium build (`channel: "chromium"`) is faster than its headless shell.
