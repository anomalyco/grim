// The landing page doodle: your cursor is a 3D pencil that draws on the page, and three bots' pencils write and draw
// there too (their engine runs right here: ../bots/engine.ts). Everything stays in this page: nothing is sent or kept,
// and every load starts afresh. Loaded lazily by the landing page only. Messages and page units: ./doodle.ts.
import { DOODLE, pickPencilColors, type Peer } from "./doodle.ts";
import { BotEngine, type BotMessage } from "../bots/engine.ts";
import { InkLayer, type InkStroke } from "./ink.ts";
import { Clashes } from "./clash.ts";
import { PencilRenderer, type PencilPose } from "./pencils.ts";
import { stabBridge } from "../stab.ts";

/** The bots' pencils play back this far behind real time, so each step's batch of points comes out smooth. */
const DELAY = 140;
const HOVER_Z = 12;
/** Where the pencil gives way to the system cursor (app.css gives each of these one). Text blocks count, so their
 *  text can be selected. */
const INTERACTIVE =
  "a, button, input, textarea, select, label, summary, [contenteditable], [role=button], .home-editor, .form-error, .site-footer";
/** Where a finger draws: the blank paper above the fold (app.css gives it touch-action, so one finger draws there and
 *  two scroll or zoom); below it, touch scrolls as usual. */
const PAPER = ".home-hero";
const TILT = 0.88;
const AZIMUTH = 1.02;
/** Over a monster (../wall/monsters.ts), your pencil takes a stabbing grip: this much of its tilt goes, tip down,
 *  and it hovers this high (px). A stab: drawn back (px) over the first part of `STAB_MS`, thrust in (to `STAB_IN`,
 *  px below the page) with a squash, held, and pulled out. */
const AIM_TILT = 0.72;
const AIM_Z = 22;
const STAB_MS = [55, 95, 135, 230] as const;
const STAB_BACK = 30;
const STAB_IN = -4;
const STAB_SQUASH = 0.9;
/** with a finger, the tip is this far (px, at pencil scale 1) up the pencil from where you touch, so you hold the
 *  pencil and see its tip: the ink comes out of the tip */
const REACH = 38;
/** a touch stroke isn't sent until it's this old (ms): a second finger landing first makes it a scroll, not a mark */
const TOUCH_GRACE = 110;
/** how long your pencil stays after your finger lifts (ms) */
const TOUCH_LINGER = 900;
/** the bots' tips stay this far inside your window (px) */
const EDGE = 14;

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
}

interface InkPt {
  t: number;
  s: InkStroke;
  x: number;
  y: number;
  p: number;
}

const hex = (c: string): [number, number, number] => {
  const n = parseInt(c.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const r1 = (n: number) => Math.round(n * 10) / 10;

/** A pencil's motion: the tip follows its target; height and lean are springs, so it settles and sways. */
class Pencil {
  x = 0;
  y = 0;
  z = 0;
  private zv = 0;
  vx = 0;
  vy = 0;
  /** knocked off its spot in a clash: an offset that springs back, and a shake that dies down */
  kx = 0;
  ky = 0;
  private kvx = 0;
  private kvy = 0;
  private shake = 0;
  private shakePhase = 0;
  private ox = 0;
  private oy = 0;
  private ovx = 0;
  private ovy = 0;
  private dropping = false;
  private placed = false;
  roll = Math.random() * Math.PI;
  visible = false;
  /** on the paper and drawing: the tip stays exactly where the ink goes (no knocks or shakes moving it) */
  anchored = false;
  /** the stabbing grip (0..1, a spring toward `aimTarget`), and a stab under way (ms since it began; -1: none) */
  aim = 0;
  aimTarget = 0;
  private aimV = 0;
  private stabT = -1;
  private squash = 1;
  color: [number, number, number];

  constructor(
    color: string,
    public scale: number,
  ) {
    this.color = hex(color);
  }

  /** Put it at (x, y); with `drop`, it falls onto the page from above. */
  place(x: number, y: number, drop: boolean) {
    this.x = x;
    this.y = y;
    this.placed = true;
    this.vx = this.vy = 0;
    if (drop) {
      this.z = 420 + Math.random() * 160;
      this.zv = 0;
      this.dropping = true;
    } else this.z = HOVER_Z;
  }

  get isPlaced() {
    return this.placed;
  }


  /** Hit in a clash, pushed along (nx, ny) with strength s (about 0.4..1.5): knocked away, wobbling, a little hop. */
  knock(nx: number, ny: number, s: number) {
    this.kvx += nx * 260 * s;
    this.kvy += ny * 260 * s;
    this.ovx += nx * 3 * s;
    this.ovy += ny * 3 * s;
    if (!this.dropping) this.zv += 150 * s;
    this.shake = Math.min(1.3, this.shake + 0.8 * s);
  }

  /** A stab: back, in, out (STAB_MS). */
  stab() {
    this.stabT = 0;
    this.dropping = false;
  }

  /** Pushed out of another pencil's way. */
  nudge(dx: number, dy: number) {
    this.kx += dx;
    this.ky += dy;
  }

  update(dt: number, tx: number, ty: number, tz: number) {
    this.aimV += ((this.aimTarget - this.aim) * 260 - this.aimV * 30) * dt;
    this.aim = clamp(this.aim + this.aimV * dt, 0, 1.1);
    const nvx = (tx - this.x) / dt;
    const nvy = (ty - this.y) / dt;
    const a = Math.min(1, dt * 14);
    this.vx += (nvx - this.vx) * a;
    this.vy += (nvy - this.vy) * a;
    this.x = tx;
    this.y = ty;
    if (this.dropping) {
      this.zv -= 2800 * dt;
      this.z += this.zv * dt;
      if (this.z <= tz) {
        this.z = tz;
        if (this.zv < -160) {
          // bounce, and the impact knocks it off balance a little
          this.zv = -this.zv * 0.3;
          this.ovx += (Math.random() - 0.5) * 4;
          this.ovy += (Math.random() - 0.3) * 4;
        } else {
          this.dropping = false;
          this.zv = 0;
        }
      }
    } else if (this.stabT >= 0) {
      // the stab overrides its height: quick, punchy, eased
      this.stabT += dt * 1000;
      const [a, b, c, d] = STAB_MS;
      const t = this.stabT;
      const ease = (u: number) => 1 - (1 - clamp(u, 0, 1)) ** 2;
      this.z = t < a ? tz + STAB_BACK * ease(t / a)
        : t < b ? tz + STAB_BACK + (STAB_IN - tz - STAB_BACK) * clamp((t - a) / (b - a), 0, 1) ** 2
        : t < c ? STAB_IN
        : STAB_IN + (tz - STAB_IN) * ease((t - c) / (d - c));
      this.squash = t >= b - 10 && t < c + 20 ? STAB_SQUASH : 1;
      this.zv = 0;
      if (t >= d) {
        this.stabT = -1;
        this.squash = 1;
      }
    } else if (this.anchored) {
      this.z = tz;
      this.zv = 0;
    } else {
      this.zv += ((tz - this.z) * 320 - this.zv * 32) * dt;
      this.z = Math.max(0, this.z + this.zv * dt);
    }
    // lean into the motion: the eraser end trails behind the tip
    const k = 0.00085;
    const sp = Math.hypot(this.vx, this.vy);
    const lim = sp * k > 0.55 ? 0.55 / (sp * k) : 1;
    const txo = -this.vx * k * lim;
    const tyo = -this.vy * k * lim;
    this.ovx += ((txo - this.ox) * 150 - this.ovx * 13) * dt;
    this.ovy += ((tyo - this.oy) * 150 - this.ovy * 13) * dt;
    this.ox += this.ovx * dt;
    this.oy += this.ovy * dt;
    this.roll += this.vx * dt * 0.004;
    // the knock springs back (underdamped: it wobbles back into place)
    this.kvx += (-this.kx * 110 - this.kvx * 10) * dt;
    this.kvy += (-this.ky * 110 - this.kvy * 10) * dt;
    this.kx = clamp(this.kx + this.kvx * dt, -70, 70);
    this.ky = clamp(this.ky + this.kvy * dt, -70, 70);
    this.shake = Math.max(0, this.shake - dt * 3.5);
    this.shakePhase += dt * 70;
  }

  get settled() {
    return (
      !this.dropping &&
      Math.abs(this.zv) < 1 &&
      Math.hypot(this.ovx, this.ovy) < 0.01 &&
      Math.hypot(this.vx, this.vy) < 2 &&
      Math.hypot(this.kx, this.ky) < 0.3 &&
      Math.hypot(this.kvx, this.kvy) < 2 &&
      this.shake === 0 &&
      this.stabT < 0 &&
      Math.abs(this.aim - this.aimTarget) < 0.01 &&
      Math.abs(this.aimV) < 0.05
    );
  }

  pose(ox: number, oy: number): PencilPose {
    const tilt = TILT * (1 - AIM_TILT * this.aim);
    const s = Math.sin(tilt);
    // shaken across its length
    const j = Math.sin(this.shakePhase) * this.shake;
    const a = this.anchored ? 0 : 1;
    return {
      x: ox + this.x + (this.kx + j * 2.2) * a,
      y: oy + this.y + (this.ky - j * 1.3) * a,
      z: this.z,
      ax: s * Math.cos(AZIMUTH) + this.ox + j * 0.05,
      ay: s * Math.sin(AZIMUTH) + this.oy,
      az: Math.cos(tilt),
      roll: this.roll + this.ox * 0.6 + j * 0.5,
      scale: this.scale * this.squash,
      color: this.color,
    };
  }
}

/** A bot's pencil on the page: where it's been told it is (played back DELAY behind), and its name label. */
interface BotPen {
  peer: Peer;
  pencil: Pencil;
  samples: Sample[];
  ink: InkPt[];
  label: HTMLElement;
  /** the label's width (px), measured when it's near the right edge */
  lw: number;
  lastT: number;
  lx: number;
  ly: number;
  lHidden: boolean;
}

/** Mount the doodle on the home page's root; returns its teardown. */
export function mountDoodle(app: HTMLElement): () => void {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** Every pencil (yours and the bots') comes onto the page the same way: dropped from above
   *  (Pencil.place), unless motion is reduced: then it's just there. (Yours also not under a finger.) */
  const dropsIn = () => !reduced;
  const finePointer = matchMedia("(pointer: fine)").matches;
  const ink = new InkLayer();
  app.prepend(ink.canvas);
  const labels = document.createElement("div");
  labels.className = "doodle-labels";
  labels.setAttribute("aria-hidden", "true");
  app.append(labels);

  let renderer: PencilRenderer | null = null;
  let glCanvas: HTMLCanvasElement | null = null;
  if (!reduced) {
    glCanvas = document.createElement("canvas");
    glCanvas.className = "doodle-gl";
    glCanvas.setAttribute("aria-hidden", "true");
    app.append(glCanvas);
    renderer = PencilRenderer.create(glCanvas);
    if (!renderer) glCanvas.remove();
  }
  const clashes = renderer ? new Clashes() : null;
  if (clashes) app.append(clashes.canvas);

  // ---- the bots: their engine, and their pencils here ----
  // four pencil colours for this page load, no two alike: yours, then the three bots'
  const [myColor, ...botColors] = pickPencilColors(4) as [string, ...string[]];
  const engine = new BotEngine({
    emit: (m) => {
      onMessage(m);
      wake();
    },
    colors: botColors,
  });
  const pens = new Map<string, BotPen>();
  /** reduced motion: strokes held back until they're finished, by stroke id */
  const pendingReduced = new Map<string, { s: InkStroke; pts: number[] }>();
  /** your pencil: with working 3D pencils (drawing needs it). A mouse or pen moves it around; a finger brings it out
   *  on the paper while it draws. */
  const mine = renderer ? new Pencil(myColor, 1) : null;
  const paper = app.querySelector<HTMLElement>(PAPER);

  // ---- page geometry ----
  let rect = app.getBoundingClientRect();
  let rectDirty = false;
  const updateRect = () => {
    if (!rectDirty) return;
    rectDirty = false;
    rect = app.getBoundingClientRect();
    measureView();
    sendView();
  };
  // the page's height: the bottom of its content (#app itself is only as tall as the window), not counting the doodle
  const own = new Set<Element>([ink.canvas, labels]);
  if (glCanvas) own.add(glCanvas);
  if (clashes) own.add(clashes.canvas);
  const pageHeight = () => {
    let h = window.innerHeight;
    for (const el of app.children) if (!own.has(el) && el instanceof HTMLElement) h = Math.max(h, el.offsetTop + el.offsetHeight);
    return h;
  };
  // a new canvas costs a repaint: height-only changes (the editor growing line by line) wait until they settle
  let sizeTimer: ReturnType<typeof setTimeout> | null = null;
  let sizedW = -1;
  const sizeInk = () => {
    rectDirty = true;
    if (sizeTimer) clearTimeout(sizeTimer);
    sizeTimer = null;
    const w = app.clientWidth;
    if (w !== sizedW) {
      sizedW = w;
      ink.resize(w, pageHeight());
      wake();
    } else
      sizeTimer = setTimeout(() => {
        sizeTimer = null;
        rectDirty = true;
        ink.resize(app.clientWidth, pageHeight());
        wake();
      }, 400);
  };
  const ro = new ResizeObserver(sizeInk);
  ro.observe(app);
  for (const el of app.children) if (!own.has(el)) ro.observe(el);
  const toPage = (cx: number, cy: number) => ({ x: cx - rect.left - rect.width / 2, y: cy - rect.top });
  // The window the fixed layers (pencils, labels, clash marks) cover, in CSS px: the layout viewport (what clientX/Y
  // and fixed positions are relative to), as tall as the visible area gets. They're sized and projected from these
  // same numbers: on phones `100vh` is taller than the window while the toolbar shows, and a canvas stretched to it
  // drew every pencil below where its ink went.
  let vw = 1;
  let vh = 1;
  /** pencils are smaller on narrow screens */
  let pscale = 1;
  const measureView = () => {
    const de = document.documentElement;
    const vv = window.visualViewport;
    vw = Math.max(1, de.clientWidth || innerWidth, vv ? Math.ceil(vv.offsetLeft + vv.width) : 0);
    vh = Math.max(1, de.clientHeight, innerHeight, vv ? Math.ceil(vv.offsetTop + vv.height) : 0);
    pscale = clamp(vw / 760, 0.72, 1);
  };
  measureView();
  let sizedView = "";
  const sizeLayers = () => {
    const key = `${vw}x${vh}`;
    if (key === sizedView) return;
    sizedView = key;
    for (const el of [glCanvas, labels]) {
      if (!el) continue;
      el.style.width = `${vw}px`;
      el.style.height = `${vh}px`;
    }
  };
  sizeLayers();

  /** Tell the bots how much paper we see (they keep to it): the window's width, and its height down to the bottom of
   *  the blank paper. */
  let sentView = "";
  function sendView() {
    const bottom = paper ? paper.offsetTop + paper.offsetHeight : vh;
    const w = Math.round(vw);
    const h = Math.round(Math.min(vh, bottom));
    const v = `${w},${h}`;
    if (v === sentView) return;
    sentView = v;
    engine.view(w, h);
  }

  /** A bot's pencil and label (the pencil shows, dropping in, with the bot's first move: see frame). */
  function addPen(peer: Peer) {
    const label = document.createElement("div");
    label.className = "doodle-label";
    label.style.setProperty("--c", peer.color);
    label.textContent = peer.name;
    label.hidden = true;
    labels.append(label);
    pens.set(peer.id, { peer, pencil: new Pencil(peer.color, 1.12), samples: [], ink: [], label, lw: 0, lastT: 0, lx: NaN, ly: NaN, lHidden: true });
  }

  function flushPending(sid: string) {
    const b = pendingReduced.get(sid);
    pendingReduced.delete(sid);
    // the whole stroke shows up now, and fades away together
    if (b) ink.push(b.s, b.pts, performance.now());
  }

  /** What a bot did (../bots/engine.ts): its pencil moves, its stroke's points (played back DELAY behind, along with
   *  its pencil), or its line or drawing is finished (its ink fades INK_MS from then). */
  function onMessage(msg: BotMessage) {
    const m = msg as Record<string, any>;
    const now = performance.now();
    if (m.t === "c") {
      const r = pens.get(m.id);
      if (!r) return;
      const t = Math.max(now, r.lastT);
      r.lastT = t;
      r.samples.push({ t, x: m.x, y: m.y, z: typeof m.z === "number" ? m.z : HOVER_Z });
    } else if (m.t === "s") {
      const sid = `s${m.id}`;
      const r = pens.get(m.u);
      const p = m.p as number[];
      const n = p.length / 3;
      const st = ink.add(sid, m.c, m.w, now);
      if (reduced) {
        // no pencil to follow: show the stroke when it's finished
        const b = pendingReduced.get(sid) ?? { s: st, pts: [] as number[] };
        for (const v of p) b.pts.push(v);
        pendingReduced.set(sid, b);
        if (m.e) flushPending(sid);
        return;
      }
      if (!r) return void ink.push(st, p, now);
      // spread the batch over the interval it was drawn in, and move the pencil along it
      for (let i = 0; i < n; i++) {
        const t = Math.max(r.lastT, now - DOODLE.batchMs + ((i + 1) * DOODLE.batchMs) / n);
        r.lastT = t;
        const x = p[i * 3]!;
        const y = p[i * 3 + 1]!;
        r.ink.push({ t, s: st, x, y, p: p[i * 3 + 2]! });
        r.samples.push({ t, x, y, z: 0 });
      }
    } else if (m.t === "d") {
      // (played back DELAY behind: finished as that plays back here)
      for (const id of m.ids as number[]) {
        const st = ink.strokes.get(`s${id}`);
        if (st) ink.done(st, now + DELAY);
      }
    }
  }

  // ---- your pencil ----
  // A mouse or pen draws anywhere outside text and controls (the pencil is the cursor). A finger draws on the paper
  // (PAPER): one finger draws (with the tip REACH up the pencil from it, so you see where the ink goes), a second
  // finger turns it into a scroll or zoom; everywhere else touch scrolls as usual.
  /** where your pencil's tip is (client px) */
  let px = 0;
  let py = 0;
  let overPage = false;
  let overInteractive = false;
  let drawing = false;
  /** the pencil is out because of a finger (it goes away when the finger lifts) */
  let touchMode = false;
  /** the pointer drawing */
  let drawId = -1;
  let strokeStart = 0;
  /** fingers down that started on the paper */
  const touches = new Map<number, { x: number; y: number }>();
  let panMid: { x: number; y: number } | null = null;
  let lingerTimer: ReturnType<typeof setTimeout> | null = null;
  let strokeKey = 0;
  let localStroke: ReturnType<typeof ink.add> | null = null;
  let cursorDirty = false;
  let lastCursor = 0;
  let pressure = 0.6;
  let lastPt: { x: number; y: number; t: number } | null = null;
  let lastTarget: EventTarget | null = null;
  let lastTargetInteractive = false;

  const isInteractive = (el: EventTarget | null) => {
    if (el === lastTarget) return lastTargetInteractive;
    lastTarget = el;
    lastTargetInteractive = el instanceof Element && !!el.closest(INTERACTIVE);
    return lastTargetInteractive;
  };
  if (mine && finePointer) app.classList.add("doodle-on");
  if (mine) app.classList.add("doodle-paper");

  /** The tip for a pointer at (e.clientX, e.clientY): right there, or with a finger, up the pencil from it. */
  const tipX = (e: PointerEvent) => e.clientX - (e.pointerType === "touch" ? Math.cos(AZIMUTH) * REACH * pscale : 0);
  const tipY = (e: PointerEvent) => e.clientY - (e.pointerType === "touch" ? Math.sin(AZIMUTH) * REACH * pscale : 0);
  const coalesced = (e: PointerEvent) => {
    const all = e.getCoalescedEvents?.();
    return all?.length ? all : [e];
  };

  function addPoint(e: PointerEvent) {
    const { x, y } = toPage(tipX(e), tipY(e));
    const t = e.timeStamp;
    if (lastPt && Math.hypot(x - lastPt.x, y - lastPt.y) < 1.2) return;
    if (e.pointerType === "pen" && e.pressure > 0) pressure = e.pressure;
    else {
      const v = lastPt ? Math.hypot(x - lastPt.x, y - lastPt.y) / Math.max(1, t - lastPt.t) : 0;
      // faster strokes press lighter, with a little flutter
      pressure += (clamp(0.9 - v * 0.22, 0.35, 0.9) - pressure) * 0.3;
    }
    const pr = clamp(pressure * (0.93 + Math.random() * 0.07), 0.1, 1);
    lastPt = { x, y, t };
    const q = [r1(clamp(x, DOODLE.minX, DOODLE.maxX)), r1(clamp(y, DOODLE.minY, DOODLE.maxY)), Math.round(pr * 100) / 100];
    if (localStroke) ink.push(localStroke, q, performance.now());
    cursorDirty = true;
  }

  function startStroke(e: PointerEvent) {
    rectDirty = true;
    updateRect();
    (document.activeElement as HTMLElement | null)?.blur?.();
    px = tipX(e);
    py = tipY(e);
    overPage = true;
    overInteractive = false;
    if (touchMode && mine) {
      if (lingerTimer) clearTimeout(lingerTimer);
      lingerTimer = null;
      // straight onto the paper under your finger (no falling in from above)
      const at = toPage(px, py);
      mine.place(at.x, at.y, false);
    }
    drawing = true;
    drawId = e.pointerId;
    app.classList.add("doodling");
    strokeKey++;
    lastPt = null;
    pressure = 0.55;
    strokeStart = performance.now();
    localStroke = ink.add(`me${strokeKey}`, myColor, 2.2, strokeStart);
    addPoint(e);
    wake();
  }

  /** A second finger came down: it's a scroll or a zoom. A stroke just begun (TOUCH_GRACE) goes; an older one ends. */
  function cancelStroke() {
    if (!drawing) return;
    if (localStroke && performance.now() - strokeStart < TOUCH_GRACE) {
      ink.remove(localStroke.id);
      drawing = false;
      drawId = -1;
      localStroke = null;
      app.classList.remove("doodling");
    } else onUp();
  }

  function pan() {
    let x = 0;
    let y = 0;
    for (const t of touches.values()) {
      x += t.x / touches.size;
      y += t.y / touches.size;
    }
    if (panMid) window.scrollBy(panMid.x - x, panMid.y - y);
    panMid = { x, y };
  }

  /** The finger lifted: the pencil hovers a moment, then goes. */
  function linger() {
    if (lingerTimer) clearTimeout(lingerTimer);
    lingerTimer = setTimeout(() => {
      lingerTimer = null;
      if (drawing || !touchMode) return;
      overPage = false;
      wake();
    }, TOUCH_LINGER);
  }

  const onMove = (e: PointerEvent) => {
    if (e.pointerType === "touch") {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (drawing && e.pointerId === drawId) {
        px = tipX(e);
        py = tipY(e);
        updateRect();
        for (const ce of coalesced(e)) addPoint(ce);
        wake();
      } else if (touches.size >= 2) pan();
      return;
    }
    touchMode = false;
    px = e.clientX;
    py = e.clientY;
    overPage = true;
    overInteractive = !drawing && isInteractive(e.target);
    if (drawing) {
      updateRect();
      for (const ce of coalesced(e)) addPoint(ce);
    } else cursorDirty = true;
    wake();
  };
  const onDown = (e: PointerEvent) => {
    if (!mine || e.button !== 0) return;
    if (e.pointerType === "touch") {
      // the first finger has to land on the paper (not on its links); later ones join it
      if (!touches.size && (!(e.target instanceof Element) || !e.target.closest(PAPER) || isInteractive(e.target))) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 1) {
        if (drawing) onUp();
        touchMode = true;
        startStroke(e);
      } else {
        cancelStroke();
        overPage = false;
        panMid = null;
        pan();
        wake();
      }
      return;
    }
    // only with your pencil showing: elsewhere (text, controls) the page behaves as usual
    if (isInteractive(e.target)) return;
    e.preventDefault();
    touchMode = false;
    startStroke(e);
  };
  function onUp(e?: PointerEvent) {
    if (e?.pointerType === "touch") {
      touches.delete(e.pointerId);
      if (touches.size < 2) panMid = null;
      if (e.pointerId !== drawId) {
        if (!touches.size && !drawing && touchMode) linger();
        return;
      }
    }
    if (!drawing) return;
    drawing = false;
    drawId = -1;
    app.classList.remove("doodling");
    // (your stroke is finished: it fades INK_MS from now)
    if (localStroke) ink.done(localStroke);
    localStroke = null;
    if (touchMode) linger();
    wake();
  }
  const onBlur = () => {
    touches.clear();
    panMid = null;
    onUp();
  };
  const onLeave = (e: PointerEvent) => {
    // (a finger "leaves" every time it lifts)
    if (e.relatedTarget || e.pointerType === "touch") return;
    // (Safari says the pointer left, with nowhere it went, when it moves onto bare page background: it's only gone
    // when it's at the window's edge)
    const m = 8;
    if (e.clientX > m && e.clientY > m && e.clientX < innerWidth - m && e.clientY < innerHeight - m) return;
    overPage = false;
    onUp();
    wake();
  };
  const onScroll = () => {
    rectDirty = true;
    wake();
  };
  // iOS doesn't always honour touch-action: a finger drawing on the paper must not scroll the page
  const onTouchMove = (e: TouchEvent) => {
    if (drawing && touchMode && e.touches.length === 1 && e.cancelable) e.preventDefault();
  };
  // a stab at a monster (the wall caught the click before us): your pencil goes there and stabs
  stabBridge.onAim = () => wake();
  stabBridge.onStab = (x, y, touch) => {
    if (!mine) return;
    px = x;
    py = y;
    overPage = true;
    overInteractive = false;
    if (touch) {
      touchMode = true;
      rectDirty = true;
      updateRect();
      const at = toPage(x, y);
      mine.place(at.x, at.y, false);
      linger();
    } else if (!mine.isPlaced) {
      const at = toPage(x, y);
      mine.place(at.x, at.y, false);
    }
    mine.stab();
    wake();
  };
  document.addEventListener("pointermove", onMove, { passive: true });
  document.addEventListener("pointerdown", onDown);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
  document.addEventListener("pointerout", onLeave);
  paper?.addEventListener("touchmove", onTouchMove, { passive: false });
  window.addEventListener("blur", onBlur);
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  window.visualViewport?.addEventListener("resize", onScroll);
  window.visualViewport?.addEventListener("scroll", onScroll);

  // nobody looking: the bots stop where they are (the frame loop does anyway), and carry on when you're back
  const onVisibility = () => {
    if (document.hidden) {
      onUp();
      engine.pause();
    } else {
      engine.resume();
      wake();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  // names change width when the page's fonts come in: place them again (a parked pencil's loop may be asleep)
  const onFonts = () => {
    for (const r of pens.values()) r.lx = NaN;
    wake();
  };
  document.fonts?.addEventListener("loadingdone", onFonts);

  /** Tell the bots where your pencil is (they may pick a fight with it, or chase it when it jabs them: not while it's
   *  drawing); true when an update is still due (throttled). */
  function tellBots(now: number): boolean {
    const show = overPage && !overInteractive;
    if (!show) {
      if (engine.visitor.shown) engine.cursor(null);
      cursorDirty = false;
      return false;
    }
    if (!cursorDirty) return false;
    if (now - lastCursor < 50) return true;
    engine.cursor(toPage(px, py), !drawing);
    cursorDirty = false;
    lastCursor = now;
    return false;
  }

  // ---- frame loop: runs while something moves, then sleeps until an event (or a fade step) wakes it ----
  let last = performance.now();
  let raf = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let glDirty = true;
  let stopped = false;
  function wake() {
    if (raf || stopped) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    last = Math.max(last, performance.now() - 50);
    raf = requestAnimationFrame(frame);
  }
  function frame(now: number) {
    raf = 0;
    const dt = clamp((now - last) / 1000, 0.001, 0.05);
    last = now;
    updateRect();
    sizeLayers();
    let busy = drawing || tellBots(now);

    const rt = now - DELAY;
    const ox = rect.left + rect.width / 2;
    const oy = rect.top;
    const poses: PencilPose[] = [];
    const bodies: { key: string; pencil: Pencil; pose: PencilPose; color: string }[] = [];
    let animating = false;
    for (const r of pens.values()) {
      // each point's life starts when it's played back, DELAY after it came in
      while (r.ink.length && r.ink[0]!.t <= rt) {
        const q = r.ink.shift()!;
        ink.push(q.s, [q.x, q.y, q.p], now);
      }
      if (r.ink.length || r.samples.length > 1 || (r.samples[0] && r.samples[0].t > rt)) busy = true;
      // position at the playback time, between the samples around it
      let i = 0;
      while (i + 1 < r.samples.length && r.samples[i + 1]!.t <= rt) i++;
      if (i > 0) r.samples.splice(0, i);
      const a = r.samples[0];
      const b = r.samples[1];
      if (a && a.t <= rt) {
        let x = a.x;
        let y = a.y;
        let z = a.z;
        if (b && b.t > a.t) {
          const u = clamp((rt - a.t) / (b.t - a.t), 0, 1);
          x += (b.x - a.x) * u;
          y += (b.y - a.y) * u;
          z += (b.z - a.z) * u;
        }
        // (its first move brings it in: it drops onto the page as any pencil does, yours included: see dropsIn)
        if (!r.pencil.isPlaced) {
          r.pencil.place(x, y, dropsIn());
          r.pencil.visible = true;
        }
        r.pencil.update(dt, x, y, z);
      } else if (r.pencil.visible) r.pencil.update(dt, r.pencil.x, r.pencil.y, HOVER_Z);
      if (r.pencil.visible) {
        r.pencil.scale = 1.12 * pscale;
        const pose = r.pencil.pose(ox, oy);
        // a bot past the side of your window (it was wider): its pencil waits at the edge
        pose.x = clamp(pose.x, EDGE, vw - EDGE);
        const on = pose.y > -260 && pose.y < vh + 60;
        // (shown before it's measured and placed, so a name just shown has its width: the same frame, not the next)
        if (r.lHidden !== !on) {
          r.lHidden = !on;
          r.label.hidden = !on;
          if (on) r.lx = NaN;
        }
        if (on) {
          poses.push(pose);
          bodies.push({ key: r.peer.id, pencil: r.pencil, pose, color: r.peer.color });
          // (measured near the right edge, where it matters: it can grow once the page's fonts are in)
          if (!r.label.hidden && pose.x > vw - 240) r.lw = r.label.offsetWidth;
          let lx = Math.round(pose.x + 12);
          // (at the right edge, the name goes on the left)
          if (r.lw && lx + r.lw > vw - 4) lx = Math.round(pose.x - 12 - r.lw);
          const ly = Math.round(pose.y - pose.z * 0.3 - 30);
          if (lx !== r.lx || ly !== r.ly) {
            r.lx = lx;
            r.ly = ly;
            r.label.style.transform = `translate(${lx}px, ${ly}px)`;
          }
        }
        if (!r.pencil.settled) animating = true;
      } else if (!r.lHidden) {
        r.lHidden = true;
        r.label.hidden = true;
      }
    }
    if (mine) {
      const show = overPage && !overInteractive;
      if (show) {
        const { x, y } = toPage(px, py);
        if (!mine.isPlaced) mine.place(x, y, !touchMode && dropsIn());
        mine.visible = true;
        mine.scale = pscale;
        mine.anchored = drawing;
        mine.aimTarget = stabBridge.aiming && !drawing ? 1 : 0;
        mine.update(dt, x, y, drawing ? 0 : mine.aimTarget ? AIM_Z : HOVER_Z);
        const pose = mine.pose(ox, oy);
        poses.push(pose);
        bodies.push({ key: "me", pencil: mine, pose, color: myColor });
        if (!mine.settled) animating = true;
      } else if (mine.visible) {
        mine.visible = false;
        animating = true;
      }
    }
    if (clashes) {
      clashes.collide(bodies, now, ox, oy);
      if (clashes.draw(now, ox, oy, vw, vh)) animating = true;
    }
    ink.flush(now);
    // for tests: pencils on screen, whether yours is one, strokes on the page
    if (String(poses.length) !== app.dataset.pencils) app.dataset.pencils = String(poses.length);
    const own = mine?.visible ? "1" : "0";
    if (own !== app.dataset.mine) app.dataset.mine = own;
    if (String(ink.strokes.size) !== app.dataset.ink) app.dataset.ink = String(ink.strokes.size);
    (app as HTMLElement & { doodleTips?: number[][] }).doodleTips = poses.map((p) => [p.x, p.y, p.z, p.scale]);
    if (renderer && glCanvas) {
      if (poses.length || glDirty) {
        renderer.resize(vw, vh, Math.min(devicePixelRatio || 1, 2));
        renderer.render(poses);
      }
      glDirty = poses.length > 0 || animating;
    }
    if (busy || animating) wake();
    else if (!idleTimer) {
      // only ink fading (a step every STEP_MS), or waiting for the next mark to start fading
      const ms = ink.nextChange(performance.now());
      if (ms < Infinity) idleTimer = setTimeout(() => ((idleTimer = null), wake()), Math.max(16, ms));
    }
  }
  sizeInk();
  for (const p of engine.peers()) addPen(p);
  sendView();
  engine.start();
  if (document.hidden) engine.pause();

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    if (idleTimer) clearTimeout(idleTimer);
    if (sizeTimer) clearTimeout(sizeTimer);
    engine.stop();
    ro.disconnect();
    stabBridge.onAim = stabBridge.onStab = null;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerdown", onDown);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    document.removeEventListener("pointerout", onLeave);
    paper?.removeEventListener("touchmove", onTouchMove);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
    window.visualViewport?.removeEventListener("resize", onScroll);
    window.visualViewport?.removeEventListener("scroll", onScroll);
    if (lingerTimer) clearTimeout(lingerTimer);
    document.removeEventListener("visibilitychange", onVisibility);
    document.fonts?.removeEventListener("loadingdone", onFonts);
    app.classList.remove("doodle-on", "doodle-paper", "doodling");
    delete app.dataset.pencils;
    delete app.dataset.mine;
    delete app.dataset.ink;
    ink.canvas.remove();
    labels.remove();
    renderer?.destroy();
    glCanvas?.remove();
    clashes?.canvas.remove();
  };
}
