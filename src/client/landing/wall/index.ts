// The wall: the landing page's background is a thick wall that something is punching through from behind, drawn
// as a stylised 3D scene (hand-written WebGL2, see scene.ts). This wires the pieces together (each tunable on its
// own, parameters at the top of each module; see README.md):
//   material.ts  the look: light, bands, colours, ink, thickness    scene.ts    the renderer
//   cracks.ts    the fracture round each site                       plates.ts   the plates as rigid slabs, hinged
//   punches.ts   a punch site: each punch cracks, lifts, spits      debris.ts   knocked-out plates and crumbs
//   hole.ts      the opening onto the dark                          monsters.ts 3D monsters climbing out (three.js)
//   blood.ts     one bloody claw scratch, dripping down the page
//   timeline.ts  when each happens, and the ?wall=debug panel
// ?wall=off: none of it. Reduced motion, or no WebGL2: none of it either (the page is the plain paper it always was).
import { clamp, rand, type View } from "./core.ts";
import { MATERIAL } from "./material.ts";
import { Scene } from "./scene.ts";
import { Site, type SiteShape } from "./punches.ts";
import type { Plate } from "./plates.ts";
import { Debris } from "./debris.ts";
import { Hole } from "./hole.ts";
import type { Monsters } from "./monsters.ts";
import { stabBridge } from "../stab.ts";
import { Blood, BLOOD } from "./blood.ts";
import { debugPanel, Director, TIMELINE, type Stage } from "./timeline.ts";

/** While the visitor writes in the note: the wall fades back to the plain page over `fade` (s). */
const WRITING = { fade: 0.8 };

/** The punch sites: where (fractions of the window's width and of the first screen's height), and their character.
 *  A breaks through; B cracks, lifts a few plates and stops. */
const SITES = {
  a: { x: 0.68, y: 0.5, xLow: 0.58, yLow: 0.33, shape: { scale: 1, tilt: 1 } as SiteShape },
  b: { x: 0.24, y: 0.66, xLow: 0.26, yLow: 0.86, shape: { scale: 0.8, tilt: 0.9 } as SiteShape },
  /** phones: site B smaller still */
  lowScaleB: 0.7,
  /** the jolt (its size per punch is in TIMELINE.punches) is gone in this long (s): sharp, no swing back; a widening
   *  punch jolts this much (px) */
  joltTime: 0.08,
  joltWiden: [2.5, 3.5] as const,
};

export function mountWall(app: HTMLElement): () => void {
  const mode = new URLSearchParams(location.search).get("wall");
  // (the debug panel shows it regardless, so it can be looked at, and captured, with reduced motion on)
  if (mode === "off" || (mode !== "debug" && matchMedia("(prefers-reduced-motion: reduce)").matches)) return () => {};
  const hero = app.querySelector<HTMLElement>(".home-hero");
  if (!hero) return () => {};
  const low = matchMedia("(pointer: coarse)").matches || Math.min(screen.width, screen.height) < 600;
  const canvas = document.createElement("canvas");
  canvas.className = "wall-gl";
  canvas.setAttribute("aria-hidden", "true");
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: true, depth: true, premultipliedAlpha: true });
  if (!gl) return () => {};
  const view: View = { sx: 0, sy: 0, vw: 1, vh: 1, dpr: 1, shakeX: 0, shakeY: 0, low, px: -1e4, py: -1e4 };
  let scene: Scene;
  try {
    scene = new Scene(gl, low);
  } catch (e) {
    console.warn("wall:", e);
    return () => {};
  }
  app.prepend(canvas);

  // ---- the pieces (rebuilt by reset) ----
  let siteA: Site;
  let siteB: Site;
  let debris: Debris;
  let hole: Hole;
  /** the monsters: their module (three.js and the model) loads when they're near (the breakthrough), or when asked */
  let monsters: Monsters | null = null;
  let loading: Promise<void> | null = null;
  const loadMonsters = () => {
    loading ??= import("./monsters.ts")
      .then((m) => {
        monsters = new m.Monsters(hole, low);
        app.append(monsters.canvas);
        return monsters.ready;
      })
      .catch((e) => console.warn("wall monsters:", e));
    return loading;
  };
  let blood: Blood | null = null;
  let broken = false;
  /** plates queued to be knocked out, one every `queueGap` s */
  let queue: Plate[] = [];
  let queueT = 0;
  let queueGap = 0.05;
  let fieldW = 0;
  /** punches so far (both sites), and the one after which the blood comes */
  let punches = 0;
  let bloodAt = 0;
  /** the jolt: its direction and how long ago */
  let joltX = 0;
  let joltY = 0;
  let joltT = 1;

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
    debris = new Debris();
    siteA = new Site(a[0], a[1], low, SITES.a.shape, debris);
    const shapeB = low ? { ...SITES.b.shape, scale: SITES.b.shape.scale * SITES.lowScaleB } : SITES.b.shape;
    siteB = new Site(b[0], b[1], low, shapeB, debris);
    hole = new Hole(siteA.fracture);
    if (monsters) {
      monsters.clear();
      monsters.hole = hole;
    }
    blood?.canvas.remove();
    // (the sheet reaches below the hero, for drips that run a long way)
    blood = new Blood(w, hh + 900, low, () => {
      const [hx, hy, hr] = hole.extent();
      return [
        [hx, hy, hr + 30, false],
        [siteA.cx, siteA.cy, siteA.radius * 1.05, true],
        [siteB.cx, siteB.cy, siteB.radius * 1.05, true],
      ];
    });
    canvas.after(blood.canvas);
    broken = false;
    queue = [];
    pendingCrawlers = 0;
    punches = 0;
    spawned = 0;
    ending = [];
    endAt = -1;
    bloodAt = BLOOD.afterPunch[Math.floor(Math.random() * BLOOD.afterPunch.length)]!;
    joltT = 1;
    dirty = true;
  };

  const jolt = (px: number) => {
    const a = Math.random() * Math.PI * 2;
    joltX = Math.cos(a) * px;
    joltY = Math.sin(a) * px;
    joltT = 0;
  };

  const breakOne = (p: Plate) => {
    if (p.removed) return;
    const [hx, hy] = [siteA.cx, siteA.cy];
    siteA.knockOut(p, hx, hy);
    dirty = true;
  };

  const strength = (n: number) => TIMELINE.punches[Math.min(n, TIMELINE.punches.length - 1)]!;

  const breakThrough = () => {
    if (broken) return;
    broken = true;
    const k = strength(TIMELINE.order.length - 1);
    siteA.punch(k);
    queue.push(...siteA.breakthrough().filter((p) => !queue.includes(p)));
    queueGap = 0.045;
    jolt(rand(...k.jolt));
    punched();
    void loadMonsters();
  };

  const widen = () => {
    if (!broken) breakThrough();
    siteA.punch(strength(TIMELINE.punches.length - 1));
    jolt(rand(...SITES.joltWiden));
    const more = siteA.widen(Math.round(rand(...TIMELINE.widenPieces)), TIMELINE.widenReach).filter((p) => !queue.includes(p));
    queue.push(...more);
    queueGap = 0.07;
    // the rim's wrecked: a plate or two next to the opening tips up
    siteA.wreckRim(Math.random() < 0.5 ? 1 : 2, queue);
    return more.length === 0;
  };

  const stage: Stage = {
    punchA: (n) => {
      const k = strength(n);
      siteA.punch(k);
      jolt(rand(...k.jolt));
      punched();
      dirty = true;
    },
    punchB: (n) => {
      const k = strength(n);
      siteB.punch(k);
      jolt(rand(...k.jolt));
      punched();
      dirty = true;
    },
    breakThrough,
    widen,
    openHole: () => {
      if (!broken) breakThrough();
      for (let i = 0; i < TIMELINE.widenPunches; i++) widen();
    },
    spawnCrawler: () => {
      void loadMonsters();
      if (monsters && monsters.count + pendingCrawlers >= monsters.max) return false;
      if (spawned + pendingCrawlers >= TIMELINE.monstersPerCycle) return false;
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
      return siteA.lifting || siteB.lifting;
    },
    get broken() {
      return broken;
    },
    get crawlers() {
      return monsters?.count ?? 0;
    },
    get kills() {
      return monsters?.kills ?? 0;
    },
    get suspended() {
      return suspended;
    },
    get spawned() {
      return spawned;
    },
  };
  /** crawlers asked for before the opening's done: they come out once the plates are out */
  let pendingCrawlers = 0;

  /** The blood: one scratch, a moment after punch 2 or 3 (BLOOD.afterPunch), never after the breakthrough. */
  const punched = () => {
    if (++punches === bloodAt && !broken) blood?.plan(rand(...BLOOD.delay));
  };

  const director = new Director(stage);
  let panel: ReturnType<typeof debugPanel> | null = null;
  const params = new URLSearchParams(location.search);
  /** ?wall=debug&clock=manual: the wall only moves when told (window.wallStep(frames, fps)), for frame-exact captures */
  const manual = mode === "debug" && params.get("clock") === "manual";
  /** ?wall=debug&auto=off: nothing happens on its own (only the panel's buttons) */
  const auto = !(mode === "debug" && params.get("auto") === "off");
  if (mode === "debug") {
    panel = debugPanel(director, stage);
    document.body.append(panel.el);
    (window as unknown as { wallMonsters: () => [number, number][] }).wallMonsters = () => monsters?.points(view) ?? [];
    (window as unknown as { wallJoints: () => number[][][] }).wallJoints = () => monsters?.joints() ?? [];
    if (manual) (window as unknown as { wallStep: (n: number, fps?: number) => void }).wallStep = (n, fps = 30) => {
      for (let i = 0; i < n; i++) step(1 / fps, i === n - 1);
    };
  }

  // ---- the frame ----
  let dirty = true;
  let lastSx = -1;
  let lastSy = -1;
  let lastShake = false;
  let raf = 0;
  let last = performance.now();
  const shaken = [hero, app.querySelector<HTMLElement>(".home-page")].filter((e): e is HTMLElement => !!e);

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
      // a new width: the sites move, so start over (only before anything's happened; after, keep them where they are)
      if (!siteA.n && !siteB.n) build();
      fieldW = vw;
      blood?.resize(vw, hero.offsetHeight + 900);
      dirty = true;
    }
    view.sx = window.scrollX;
    view.sy = window.scrollY;
    view.vw = vw;
    view.vh = vh;
    view.dpr = Math.min(window.devicePixelRatio || 1, low ? MATERIAL.dprCapLow : MATERIAL.dprCap);

    if (auto && !suspended) director.update(dt);
    if (queue.length) {
      queueT -= dt;
      while (queue.length && queueT <= 0) {
        breakOne(queue.shift()!);
        queueT += queueGap;
      }
    } else queueT = 0;
    // (asked for before the model's in, or while plates are still coming out: they come once they can)
    if (pendingCrawlers && !queue.length && monsters) {
      while (pendingCrawlers > 0 && spawned < TIMELINE.monstersPerCycle && monsters.spawn()) {
        pendingCrawlers--;
        if (++spawned >= TIMELINE.monstersPerCycle) windDown();
      }
      if (spawned >= TIMELINE.monstersPerCycle) pendingCrawlers = 0;
      if (monsters.count >= monsters.max) pendingCrawlers = 0;
    }
    siteA.update(dt);
    siteB.update(dt);
    debris.update(dt, view);
    clock += dt;
    // the restoring wall has faded out: a fresh one (pristine: it looks just like the page), shown again
    if (restoreAt >= 0 && clock >= restoreAt) {
      restoreAt = -1;
      build();
      canvas.style.transition = "";
      canvas.style.opacity = "";
      // (the cycle's end: from the beginning; writing in the note: once the visitor's done, see resume)
      if (!suspended) director.reset();
    }
    // the cycle's end: one by one, then (all gone) the wall restores
    if (endAt >= 0 && !suspended) {
      while (ending.length && ending[0]! <= clock) {
        ending.shift();
        monsters?.killOne();
      }
      if (clock >= endAt) {
        while (monsters?.killOne());
        if (!monsters?.busy) restore(TIMELINE.restoreFade);
      }
    }
    if (bleeding.length) {
      for (const b of bleeding) if (b.at <= clock) b.f();
      bleeding = bleeding.filter((b) => b.at > clock);
    }
    if (monsters) {
      monsters.update(dt, view);
      aim();
    }
    blood?.update(dt, view);

    // the jolt: straight out to its full offset, then straight back (no swing past)
    if (joltT < 1) {
      joltT = Math.min(1, joltT + dt / SITES.joltTime);
      const k = clamp(1 - joltT, 0, 1);
      view.shakeX = joltX * k * k;
      view.shakeY = joltY * k * k;
    } else view.shakeX = view.shakeY = 0;
    const shaking = view.shakeX !== 0 || view.shakeY !== 0;
    if (shaking || lastShake) {
      const t = shaking ? `translate(${view.shakeX.toFixed(2)}px, ${view.shakeY.toFixed(2)}px)` : "";
      for (const e of shaken) e.style.transform = t;
    }

    if (!draw) return;
    const moving = siteA.busy || siteB.busy || debris.busy || shaking || lastShake;
    lastShake = shaking;
    if (dirty || moving) {
      scene.clear();
      siteB.draw(scene);
      siteA.draw(scene);
      hole.draw(scene, view);
      debris.draw(scene);
    }
    if (dirty || moving || view.sx !== lastSx || view.sy !== lastSy) {
      dirty = false;
      lastSx = view.sx;
      lastSy = view.sy;
      scene.render(view, canvas);
    }
    monsters?.draw(view);
    blood?.draw(view);
    panel?.tick();
  };

  // ---- stabbing the monsters with your pencil (../doodle draws the stab; ../stab.ts is between us) ----
  /** the pointer (client px), if it's a mouse or pen over the page */
  let cx = -1;
  let cy = -1;
  /** a stab took this press: its click goes nowhere either */
  let stabbed = false;
  /** blood still to come (wall clock, s) */
  let clock = 0;
  /** the visitor's writing in the note: the wall's sequence holds; and when the wall, faded out, starts afresh */
  let suspended = false;
  let restoreAt = -1;
  /** monsters out this cycle; the cycle's end: when the ones left die (wall clock), and when it's all over */
  let spawned = 0;
  let ending: number[] = [];
  let endAt = -1;
  let bleeding: { at: number; f: () => void }[] = [];
  const aim = () => {
    const on = !!monsters && cx >= 0 && monsters.hover(cx, cy, view);
    if (on !== stabBridge.aiming) {
      stabBridge.aiming = on;
      stabBridge.onAim?.();
    }
  };
  const onPointer = (e: PointerEvent) => {
    view.px = e.clientX + window.scrollX;
    view.py = e.clientY + window.scrollY;
    if (e.pointerType === "touch") return;
    cx = e.clientX;
    cy = e.clientY;
    aim();
  };
  const onDown = (e: PointerEvent) => {
    if (!monsters || e.button !== 0) return;
    const hit = monsters.stab(e.clientX, e.clientY, view);
    if (!hit) return;
    // it's a stab, and nothing else: no ink, no link
    e.preventDefault();
    e.stopImmediatePropagation();
    stabbed = true;
    // (it bleeds as the pencil's tip goes in)
    bleeding.push({ at: clock + hit.delay, f: () => blood?.spurt(hit.x, hit.y, hit.dx, hit.dy, hit.splat, hit.drops, hit.drips) });
    stabBridge.onStab?.(e.clientX, e.clientY, e.pointerType === "touch");
    aim();
  };
  const onClick = (e: MouseEvent) => {
    if (!stabbed) return;
    stabbed = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onLeave = () => {
    cx = cy = -1;
    aim();
  };
  // ---- writing in the note: the monsters die, the wall restores, and nothing happens until you're done; then it all
  // starts again from the beginning (as if the page had just loaded) ----
  const note = app.querySelector<HTMLElement>(".home-editor");
  const suspend = () => {
    if (suspended) return;
    suspended = true;
    monsters?.killAll();
    pendingCrawlers = 0;
    queue = [];
    bleeding = [];
    restore(WRITING.fade);
  };
  /** The wall (and its blood) fades back to the clean page over `fade` s; then a fresh one (see step). */
  const restore = (fade: number) => {
    ending = [];
    endAt = -1;
    for (const c of [canvas, blood?.canvas]) {
      if (!c) continue;
      c.style.transition = `opacity ${fade}s ease`;
      c.style.opacity = "0";
    }
    restoreAt = clock + fade + 0.05;
    dirty = true;
  };
  /** The cycle's last monster is out: the ones still here die one by one, then the wall restores and it starts
   *  again. */
  const windDown = () => {
    const at = clock + TIMELINE.windDownAfter;
    const n = monsters?.count ?? 0;
    ending = Array.from({ length: n }, () => at + Math.random() * TIMELINE.windDownOver).sort((a, b) => a - b);
    endAt = at + TIMELINE.windDownOver;
  };
  const resume = () => {
    if (!suspended) return;
    suspended = false;
    director.reset();
  };
  const onFocusIn = () => suspend();
  const onFocusOut = (e: FocusEvent) => {
    // (focus moving about inside the editor isn't leaving it)
    if (note && e.relatedTarget instanceof Node && note.contains(e.relatedTarget)) return;
    resume();
  };
  note?.addEventListener("focusin", onFocusIn);
  note?.addEventListener("focusout", onFocusOut);
  window.addEventListener("pointermove", onPointer, { passive: true });
  window.addEventListener("pointerdown", onDown, { capture: true });
  window.addEventListener("click", onClick, { capture: true });
  document.documentElement.addEventListener("pointerleave", onLeave);
  build();
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("pointermove", onPointer);
    window.removeEventListener("pointerdown", onDown, { capture: true });
    note?.removeEventListener("focusin", onFocusIn);
    note?.removeEventListener("focusout", onFocusOut);
    window.removeEventListener("click", onClick, { capture: true });
    document.documentElement.removeEventListener("pointerleave", onLeave);
    stabBridge.aiming = false;
    for (const e of shaken) e.style.transform = "";
    canvas.remove();
    monsters?.dispose();
    blood?.canvas.remove();
    panel?.el.remove();
  };
}
