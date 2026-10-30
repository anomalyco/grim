// The wall: the landing page's background is a painted drywall wall that something is punching through. This wires
// the pieces together (each tunable on its own, parameters at the top of each module; see README.md):
//   material.ts  the wall and its height field        punches.ts  two punch sites: bulge, knock, crack, lift, dust
//   cracks.ts    the radial fracture and its cracks   plates.ts   cracked plates lifting toward you
//   dust.ts      dust puffs and crumbs                debris.ts   plates knocked out, falling
//   hole.ts      the opening onto the dark            crawlers.ts things coming out and crawling off the page
//   blood.ts     three bloody claw scratches that drip down the page
//   timeline.ts  when each happens, and the ?wall=debug panel
// ?wall=off: none of it. Reduced motion, or no WebGL2: none of it either (the page is the plain paper it always was).
import { Batch, rand, type View } from "./core.ts";
import { Material, MATERIAL } from "./material.ts";
import { Site, type SiteShape } from "./punches.ts";
import type { Cell } from "./cracks.ts";
import { Dust } from "./dust.ts";
import { Debris } from "./debris.ts";
import { Hole } from "./hole.ts";
import { Crawlers } from "./crawlers.ts";
import { Blood, BLOOD } from "./blood.ts";
import { debugPanel, Director, TIMELINE, type Stage } from "./timeline.ts";

/** The punch sites: where (fractions of the window's width and of the first screen's height), and their character.
 *  A breaks through; B cracks, lifts and holds. */
const SITES = {
  a: { x: 0.68, y: 0.5, xLow: 0.58, yLow: 0.33, shape: { scale: 1, tilt: 1, liftMax: 1, bulge: 1 } as SiteShape },
  b: { x: 0.25, y: 0.64, xLow: 0.26, yLow: 0.86, shape: { scale: 0.75, tilt: 0.8, liftMax: 0.75, bulge: 0.8 } as SiteShape },
  /** phones: site B smaller still */
  lowScaleB: 0.7,
};

export function mountWall(app: HTMLElement): () => void {
  const mode = new URLSearchParams(location.search).get("wall");
  // (the debug panel shows it regardless, so it can be looked at, and captured, with reduced motion on)
  if (mode === "off" || (mode !== "debug" && matchMedia("(prefers-reduced-motion: reduce)").matches)) return () => {};
  const hero = app.querySelector<HTMLElement>(".home-hero");
  if (!hero) return () => {};
  const canvas = document.createElement("canvas");
  canvas.className = "wall-gl";
  canvas.setAttribute("aria-hidden", "true");
  const gl = canvas.getContext("webgl2", { stencil: true, alpha: false, antialias: false, premultipliedAlpha: true });
  if (!gl) return () => {};
  const low = matchMedia("(pointer: coarse)").matches || Math.min(screen.width, screen.height) < 600;
  const view: View = { sx: 0, sy: 0, vw: 1, vh: 1, dpr: 1, shakeX: 0, shakeY: 0, low, px: -1e4, py: -1e4 };
  let batch: Batch;
  let material: Material;
  try {
    batch = new Batch(gl);
    material = new Material(gl, low);
  } catch (e) {
    console.warn("wall:", e);
    return () => {};
  }
  app.prepend(canvas);

  // ---- the pieces (rebuilt by reset) ----
  let siteA: Site;
  let siteB: Site;
  let dust: Dust;
  let debris: Debris;
  let hole: Hole;
  let crawlers: Crawlers | null = null;
  let blood: Blood | null = null;
  let broken = false;
  /** plates queued to break out, one every `queueGap` s */
  let queue: Cell[] = [];
  let queueT = 0;
  let queueGap = 0.05;
  let fieldW = 0;
  let bloodFirst = false;
  let bloodAfter = false;

  const layout = () => {
    const w = document.documentElement.clientWidth;
    const hh = hero.offsetHeight;
    // (in the first screenful: the hero can be taller than the window)
    const h = Math.min(hh, window.innerHeight);
    const at = (s: typeof SITES.a) => [Math.round(w * (low ? s.xLow : s.x)), Math.round(h * (low ? s.yLow : s.y))] as const;
    return { w, hh, a: at(SITES.a), b: at(SITES.b) };
  };

  const build = () => {
    const { w, hh, a, b } = layout();
    fieldW = w;
    material.resize(w, hh + 120);
    dust = new Dust();
    siteA = new Site(material, dust, a[0], a[1], low, SITES.a.shape);
    const shapeB = low ? { ...SITES.b.shape, scale: SITES.b.shape.scale * SITES.lowScaleB } : SITES.b.shape;
    siteB = new Site(material, dust, b[0], b[1], low, shapeB);
    debris = new Debris(low);
    hole = new Hole(gl, siteA.fracture, material);
    crawlers?.canvas.remove();
    crawlers = new Crawlers(siteA.fracture, low);
    app.append(crawlers.canvas);
    blood?.canvas.remove();
    // (the sheet reaches below the hero, for drips that run a long way)
    blood = new Blood(w, hh + 900, low, () => {
      const [hx, hy, hr] = hole.extent();
      return [
        [hx, hy, hr + 30, false],
        [siteA.cx, siteA.cy, siteA.fracture.radius * 1.05, true],
        [siteB.cx, siteB.cy, siteB.fracture.radius * 1.05, true],
      ];
    });
    canvas.after(blood.canvas);
    broken = false;
    queue = [];
    pendingCrawlers = 0;
    bloodFirst = bloodAfter = false;
    dirty = true;
  };

  const floor = () => view.sy + view.vh;

  /** Knock a plate out: it falls from where it was lifted to; dust and crumbs go with it. */
  const breakOne = (c: Cell) => {
    if (c.removed) return;
    const pose = siteA.plates.pose(c, view);
    siteA.fracture.breakCell(c);
    hole.opened(c);
    const [hx, hy] = hole.extent();
    debris.fall(c, hx, hy, view, { tilt: pose.angle, z: pose.top * 0.5 });
    dust.puff(c.cx, c.cy, 3, 1.3, 14);
    dust.spit(c.cx, c.cy, 4, floor(), 12, 1);
    dirty = true;
  };

  const breakThrough = () => {
    if (broken) return;
    broken = true;
    const cells = siteA.breakthrough();
    queue.push(...cells.sort((p, q) => p.r - q.r));
    queueGap = 0.035;
    material.wave(siteA.cx, siteA.cy, -4);
    material.shake(1.2);
    dust.puff(siteA.cx, siteA.cy, 10, 1.6, siteA.fracture.radius * 0.2);
    dust.spit(siteA.cx, siteA.cy, 24, floor(), siteA.fracture.radius * 0.2, 1.4);
    siteA.plates.jolt(1.6);
  };

  const stage: Stage = {
    punchA: () => {
      siteA.punch(floor());
      firstPunch();
      dirty = true;
    },
    punchB: () => {
      siteB.punch(floor());
      firstPunch();
      dirty = true;
    },
    breakThrough,
    widen: () => {
      if (!broken) breakThrough();
      siteA.punch(floor());
      const cells = siteA.widen(Math.round(rand(...TIMELINE.widenPieces)), TIMELINE.widenReach);
      queue.push(...cells);
      queueGap = 0.07;
      return cells.length === 0;
    },
    openHole: () => {
      if (!broken) breakThrough();
      // ragged: the inner rings, and some of the next
      for (const c of siteA.fracture.cells) {
        if (!c.interior || c.removed || queue.includes(c)) continue;
        if (c.ring <= 2 || Math.random() < 0.45) queue.push(c);
      }
      queue.sort((p, q) => p.ring - q.ring || p.r - q.r);
      queueGap = 0.06;
    },
    spawnCrawler: () => {
      if (!crawlers || crawlers.count + pendingCrawlers >= crawlers.max) return false;
      if (!broken) stage.openHole();
      pendingCrawlers++;
      return true;
    },
    bloodScratch: () => blood?.now(view),
    reset: () => build(),
    get punchesA() {
      return siteA.n;
    },
    get punchesB() {
      return siteB.n;
    },
    get cracked() {
      return siteA.fracture.started || siteB.fracture.started;
    },
    get lifting() {
      return [siteA, siteB].some((s) => s.fracture.cells.some((c) => c.lift > 0.05));
    },
    get broken() {
      return broken;
    },
    get crawlers() {
      return crawlers?.count ?? 0;
    },
  };
  /** crawlers asked for before there's a hole big enough: they come out once the plates are out */
  let pendingCrawlers = 0;

  /** The blood's budget: one once the punching starts, two once the crawlers come. */
  const firstPunch = () => {
    if (bloodFirst) return;
    bloodFirst = true;
    blood?.plan(rand(...BLOOD.first));
  };
  const firstCrawler = () => {
    if (bloodAfter) return;
    bloodAfter = true;
    for (let i = 0; i < BLOOD.after; i++) blood?.plan(rand(...BLOOD.afterWithin));
  };

  const director = new Director(stage);
  let panel: ReturnType<typeof debugPanel> | null = null;
  /** ?wall=debug&clock=manual: the wall only moves when told (window.wallStep(frames, fps)), for frame-exact captures */
  const manual = mode === "debug" && new URLSearchParams(location.search).get("clock") === "manual";
  /** ?wall=debug&auto=off: nothing happens on its own (only the panel's buttons) */
  const auto = !(mode === "debug" && new URLSearchParams(location.search).get("auto") === "off");
  if (mode === "debug") {
    panel = debugPanel(director, stage);
    document.body.append(panel.el);
    if (manual) (window as unknown as { wallStep: (n: number, fps?: number) => void }).wallStep = (n, fps = 30) => {
      for (let i = 0; i < n; i++) step(1 / fps, i === n - 1);
    };
  }

  // ---- the frame ----
  let dirty = true;
  let lastSx = -1;
  let lastSy = -1;
  let raf = 0;
  let last = performance.now();
  const shaken = [hero, app.querySelector<HTMLElement>(".home-page")].filter((e): e is HTMLElement => !!e);
  let wasShaking = false;

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    // (a hidden tab gets no frames: the clock just stops there)
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!manual) step(dt);
  };

  const step = (dt: number, draw = true) => {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    if (vw !== fieldW) {
      const { w, hh } = layout();
      fieldW = w;
      material.resize(w, hh + 120);
      siteA.restamp();
      siteB.restamp();
      for (const c of siteA.fracture.removed) hole.opened(c);
      blood?.resize(w, hh + 900);
      dirty = true;
    }
    view.sx = window.scrollX;
    view.sy = window.scrollY;
    view.vw = vw;
    view.vh = vh;
    view.dpr = Math.min(window.devicePixelRatio || 1, low ? MATERIAL.dprCapLow : MATERIAL.dprCap);

    if (auto) director.update(dt);
    if (queue.length) {
      queueT -= dt;
      while (queue.length && queueT <= 0) {
        breakOne(queue.shift()!);
        queueT += queueGap;
      }
    } else queueT = 0;
    if (pendingCrawlers && !queue.length) {
      const [hx, hy, hr] = hole.extent();
      while (pendingCrawlers > 0) {
        if (crawlers?.spawn(hx, hy, hr, view)) firstCrawler();
        pendingCrawlers--;
      }
    }
    material.update(dt, view);
    siteA.update(dt);
    siteB.update(dt);
    dust.update(dt);
    debris.update(dt);
    hole.update(dt);
    crawlers?.update(dt, view);
    blood?.update(dt, view);

    const shaking = view.shakeX !== 0 || view.shakeY !== 0;
    if (shaking || wasShaking) {
      const t = shaking ? `translate(${view.shakeX.toFixed(2)}px, ${view.shakeY.toFixed(2)}px)` : "";
      for (const e of shaken) e.style.transform = t;
      wasShaking = shaking;
    }

    if (!draw) return;
    const moving =
      material.busy || siteA.busy || siteB.busy || dust.busy || debris.busy || siteA.fracture.removed.length > 0 ||
      [siteA, siteB].some((s) => s.fracture.cells.some((c) => c.lift > 0.004));
    if (dirty || moving || view.sx !== lastSx || view.sy !== lastSy) render();
    crawlers?.draw(view);
    blood?.draw(view);
    panel?.tick();
  };

  const render = () => {
    dirty = false;
    lastSx = view.sx;
    lastSy = view.sy;
    const w = Math.round(view.vw * view.dpr);
    const h = Math.round(view.vh * view.dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = view.vw + "px";
      canvas.style.height = view.vh + "px";
    }
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    material.draw(view);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    siteB.fracture.draw(batch, view);
    siteA.fracture.draw(batch, view);
    batch.draw(view);
    hole.draw(batch, view);
    batch.draw(view);
    // the lifted plates: the gaps and shadows under them, then the plates, lowest first
    const poses = [siteB, siteA].map((s) => [s, s.plates.poses(view)] as const);
    for (const [s, p] of poses) s.plates.drawUnder(batch, p);
    batch.draw(view);
    for (const [s, p] of poses) s.plates.drawPlates(batch, p);
    batch.draw(view);
    debris.draw(batch, view);
    dust.draw(batch);
    batch.draw(view);
  };

  const onPointer = (e: PointerEvent) => {
    view.px = e.clientX + window.scrollX;
    view.py = e.clientY + window.scrollY;
  };
  window.addEventListener("pointermove", onPointer, { passive: true });
  build();
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("pointermove", onPointer);
    for (const e of shaken) e.style.transform = "";
    canvas.remove();
    crawlers?.canvas.remove();
    blood?.canvas.remove();
    panel?.el.remove();
  };
}
