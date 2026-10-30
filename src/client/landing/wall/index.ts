// The wall: the landing page's background is a thick plastic wall that monsters are breaking through. This wires the
// pieces together (each tunable on its own, parameters at the top of each module; see README.md):
//   material.ts  the plastic and its height field     strikes.ts  claw impacts: dents, slits, flex, shake
//   cracks.ts    the fracture network and cracks      debris.ts   fragments breaking off and falling
//   hole.ts      the opening onto the dark            crawlers.ts things coming out and crawling over the page
//   timeline.ts  when each happens, and the ?wall=debug panel
// ?wall=off: none of it. Reduced motion, or no WebGL2: none of it either (the page is the plain paper it always was).
import { Batch, type View } from "./core.ts";
import { Material, MATERIAL } from "./material.ts";
import { Strikes, type Target } from "./strikes.ts";
import { Fracture } from "./cracks.ts";
import { Debris } from "./debris.ts";
import { Hole } from "./hole.ts";
import { Crawlers } from "./crawlers.ts";
import { debugPanel, Director, TIMELINE, type Stage } from "./timeline.ts";

/** Where the hole will be: a fraction of the window's width, and of the first screen's height (phones: centred). */
const HOLE_AT = { x: 0.7, y: 0.5, xLow: 0.5, yLow: 0.55 };

export function mountWall(app: HTMLElement): () => void {
  const mode = new URLSearchParams(location.search).get("wall");
  if (mode === "off" || matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};
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
  let strikes: Strikes;
  let fracture: Fracture;
  let debris: Debris;
  let hole: Hole;
  let crawlers: Crawlers | null = null;
  let target: Target;
  /** fragments queued to break in the big break, one every TIMELINE.holeGap s */
  let queue: number[] = [];
  let queueT = 0;
  let pieces = 0;
  let fieldW = 0;

  const layout = () => {
    const w = document.documentElement.clientWidth;
    const hh = hero.offsetHeight;
    const cx = Math.round(w * (low ? HOLE_AT.xLow : HOLE_AT.x));
    // (in the first screenful: the hero can be taller than the window)
    const cy = Math.round(Math.min(hh, window.innerHeight) * (low ? HOLE_AT.yLow : HOLE_AT.y));
    return { w, hh, cx, cy };
  };

  const build = () => {
    const { w, hh, cx, cy } = layout();
    fieldW = w;
    material.resize(w, hh + 120);
    strikes = new Strikes(material);
    fracture = new Fracture(cx, cy, low);
    debris = new Debris(low);
    hole = new Hole(gl, fracture, material);
    crawlers?.canvas.remove();
    crawlers = new Crawlers(fracture, low);
    app.append(crawlers.canvas);
    target = { cx, cy, box: [40, 110, w - 40, hh - 70] };
    queue = [];
    pieces = 0;
    dirty = true;
  };

  const breakOne = (cellId?: number) => {
    const c = cellId !== undefined ? fracture.cells[cellId] : fracture.nextCell();
    if (!c || c.removed) return;
    fracture.breakCell(c);
    hole.opened(c);
    const [hx, hy] = hole.extent();
    debris.fall(c, hx, hy, view);
    material.wave(c.cx, c.cy, 1.2);
    material.shake(0.5);
    pieces++;
    dirty = true;
  };

  const stage: Stage = {
    strike: () => {
      // once the hole's open, they hammer at its edge
      const at = fracture.removed.length ? rimPoint() : undefined;
      strikes.strike(target, at);
      dirty = true;
    },
    crack: () => {
      fracture.crack(strikes.punctures);
      dirty = true;
    },
    breakPiece: () => breakOne(),
    openHole: () => {
      const n = low ? TIMELINE.holePiecesLow : TIMELINE.holePieces;
      const r = fracture.radius * 0.8;
      const open = fracture.cells.filter((c) => c.interior && !c.removed && c.r < r).sort((a, b) => a.r - b.r);
      queue = open.slice(0, n).map((c) => c.id);
      queueT = 0;
    },
    spawnCrawler: () => {
      if (!fracture.removed.length) stage.openHole();
      pendingCrawler = true;
    },
    reset: () => build(),
    get strikes() {
      return strikes.count;
    },
    get pieces() {
      return pieces;
    },
    get crawlers() {
      return crawlers?.count ?? 0;
    },
  };
  /** a crawler asked for before there's a hole big enough: comes out once the big break is done */
  let pendingCrawler = false;

  const rimPoint = () => {
    const rim = fracture.rim();
    if (!rim.length) return undefined;
    const [ed] = rim[Math.floor(Math.random() * rim.length)]!;
    const v = fracture.verts[ed.a]!;
    return { x: v.x + (Math.random() - 0.5) * 30, y: v.y + (Math.random() - 0.5) * 30 };
  };

  const director = new Director(stage);
  let panel: ReturnType<typeof debugPanel> | null = null;
  /** ?wall=debug&clock=manual: the wall only moves when told (window.wallStep(frames, fps)), for frame-exact captures */
  const manual = mode === "debug" && new URLSearchParams(location.search).get("clock") === "manual";
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
      strikes.restamp();
      for (const c of fracture.removed) hole.opened(c);
      target.box = [40, 110, w - 40, hh - 70];
      dirty = true;
    }
    view.sx = window.scrollX;
    view.sy = window.scrollY;
    view.vw = vw;
    view.vh = vh;
    view.dpr = Math.min(window.devicePixelRatio || 1, low ? MATERIAL.dprCapLow : MATERIAL.dprCap);

    director.update(dt);
    if (queue.length) {
      queueT -= dt;
      while (queue.length && queueT <= 0) {
        breakOne(queue.shift());
        queueT += TIMELINE.holeGap;
      }
    }
    if (pendingCrawler && !queue.length) {
      const [hx, hy, hr] = hole.extent();
      crawlers?.spawn(hx, hy, hr, view);
      pendingCrawler = false;
    }
    material.update(dt, view);
    strikes.update(dt);
    fracture.update(dt);
    debris.update(dt);
    hole.update(dt);
    crawlers?.update(dt, view);

    const shaking = view.shakeX !== 0 || view.shakeY !== 0;
    if (shaking || wasShaking) {
      const t = shaking ? `translate(${view.shakeX.toFixed(2)}px, ${view.shakeY.toFixed(2)}px)` : "";
      for (const e of shaken) e.style.transform = t;
      wasShaking = shaking;
    }

    if (!draw) return;
    const moving = material.busy || strikes.busy || fracture.busy || debris.busy || fracture.removed.length > 0;
    if (dirty || moving || view.sx !== lastSx || view.sy !== lastSy) render();
    crawlers?.draw(view);
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
    strikes.draw(batch, view);
    fracture.draw(batch, view);
    batch.draw(view);
    hole.draw(batch, view);
    batch.draw(view);
    debris.draw(batch, view);
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
    panel?.el.remove();
  };
}
