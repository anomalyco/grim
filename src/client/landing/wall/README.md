# The wall

The landing page's background is a thick white plastic wall, and something behind it wants out. Over about three
minutes from page load, claws hit it from behind, cracks spread from the punctures, pieces fall out onto a dark space
behind, a big hole opens, and things with big hands and wrong faces crawl out over the page. Everything runs in the
browser and starts from scratch on every load.

`?wall=off` turns it off (to compare). `?wall=debug` shows a panel: a button per step, a 1×–20× clock and the phase.
`?wall=debug&clock=manual` stops the clock: `window.wallStep(frames, fps = 30)` advances it, for frame-exact captures.
It's also off with `prefers-reduced-motion` (no shake, no crawlers, and no dents either: the page is plain paper) and
without WebGL2.

## The pieces

Each is its own module with its parameters in one object at the top. Change a number, save; the preview rebuilds.

| Module | What it does | Parameters |
| --- | --- | --- |
| `material.ts` | The plastic: a full-window WebGL pass shading a height field (page px, over the hero) under a key light from the top left. Flat, it's exactly the paper colour plus a faint gloss falloff and grain. Also the flex waves and the page shake. | `MATERIAL`: cell size, light, diffuse/brighten/specular, occlusion, relief, sheen, grain, wave speed/length/decay, flex, shake |
| `strikes.ts` | A claw strike: 3–4 tips in a slightly curved row, each a sharp point pushed into the height field with a shallow trough round it, the palm bending the wall behind them, a tiny dark slit at each tip, a flex wave and a shake. Dents and slits stay. 75% land in a cluster where the hole will be. | `STRIKE`: direction (+1 pushed out toward you, -1 pressed in), claws, spacing, curve, depth, length, width, trough, palm, overshoot/settle timing, slit size, growth per strike, cluster share and spread, wave, shake |
| `cracks.ts` | The fracture network: a Voronoi split of the region round the hole (smaller pieces near the middle, every edge jagged, shared by both neighbours), invisible until cracks run along it. Spurs from each slit to the nearest corner, then corner to corner, mostly toward the middle, sometimes running on. Cracks widen and darken with age. Stray slits get short hairlines. | `CRACK`: region radius, cell size range, jaggedness, growth speed, run-on chance, width/darkness when new and old, aging time, stray hairlines |
| `debris.ts` | A fragment breaking off: shoved toward you, spinning, tipping over (its thickness shows), falling under gravity with its shadow sliding on the wall, bouncing at the bottom of the window, fading. Plus chips. | `DEBRIS`: gravity, push/out/up speeds, spin, tip, perspective, thickness, bounce, linger/fade, shadow, chips, max at once (phones fewer) |
| `hole.ts` | The opening: removed fragments drawn into the stencil twice, as they are and as the far side of the wall (pulled toward the window's middle by the plastic's thickness, so it shifts as you scroll). Through both: the dark (vignette, slow stir, something huge passing). In front only: the broken edge, lit by the key light. A bright lip and dark seam along the outline; the plastic round a break bulges out. | `HOLE`: depth (thickness), tilt, dark colours, stir, passing, edge shades, lip, seam, bulge |
| `crawlers.ts` | Things coming out: big clawed hands slap onto the rim, a pale face with mismatched black eyes and a vertical needle-toothed mouth rises (clipped to the hole while it's inside), then it hauls out, drops onto the page and crawls off it in a random direction (two-bone IK arms with high spiked elbows, hands planted until left behind, stepping in two alternating sets, lurching), and is removed once it's off the window. Speed, size, gait and emergence pace vary per crawler. Several can be coming out at once. A 2D canvas over the content, under the pencils, `pointer-events: none`. | `CRAWLER`: max at once (25; phones 8), `simpleAbove` (cheaper drawing past this many), limbs (phones 4), head size, size, speed, lurch, drift, step distance/time and gait range, emergence timings and pace range, colours, shadow |
| `timeline.ts` | The director: when each step happens, counted from page load, all in `TIMELINE`. And the debug panel. The clock scale speeds up the schedule, not the animations. | `TIMELINE`: first strike, strike intervals (before/while cracking/after the hole), cracking start and interval, first break and interval, the big break (when, how many pieces, gap), later growth, and the crawler stream: `crawlersFrom`, then gaps from `pourFirst` (6 s) shrinking by `pourShrink` each time down to `pourMin` (0.7 s), with `pourJitter` |
| `index.ts` | Wires it up: the canvases, the frame loop (draws only when something changes or moves; a hidden tab gets no frames, so the clock stops), resizing, the shake, the pointer. `HOLE_AT` places the hole. | `HOLE_AT` |
| `core.ts` | Shared: the view, random helpers, WebGL helpers, the batched coloured-triangles program everything but the material and the dark draws with, and triangulation. | – |

Layering: `.wall-gl` (fixed, z-index 0) is behind the page's content and the pencils' ink; the dents, cracks and hole
are on it. `.wall-crawlers` (fixed, z-index 25) is over the content and under the pencils (z-index 30). The note and
footer have their own backgrounds, so the wall shows above the fold and in the margins.

Phones (coarse pointer or a small screen): a coarser height field, device pixel ratio 1, a smaller fracture region,
fewer pieces in the big break and falling at once, one crawler with four limbs.

## Iterating

- **One piece at a time:** open `?wall=debug` and fire just that step (Strike, Crack, Break piece, Open hole, Spawn
  crawler, or Flood for the full stream at once); Reset starts over without reloading. The readout shows how many
  crawlers are live. Crack needs a few strikes first (it grows from their slits); Spawn
  crawler opens the hole first if there isn't one.
- **The pacing:** edit `TIMELINE`, then watch the whole run with the clock at 10× or 20×.
- **The look of the plastic:** `MATERIAL.diffuse`/`brighten`/`occlusion`/`relief` set how strongly dents read;
  `sheen` and `grain` are the resting look (keep them tiny: at rest it should read as the paper).
- **Dents in or out:** `STRIKE.direction`. Out (the default) is what claws from behind would do; in reads as a dent
  from the front.
- **Captures:** with `?wall=debug&clock=manual`, call `wallStep(1)` and screenshot per frame (Playwright), then
  `ffmpeg -framerate 30`. Headless Chromium renders WebGL in software, far slower than a laptop, which is why the clock
  can be stepped.
