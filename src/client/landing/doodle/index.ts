// The home page doodle: your cursor is a 3D pencil that draws on the page, and you see everyone else's pencils
// (people and the server's bots) and drawings live over /ws/home. Loaded lazily by the home page only.
// Protocol and page units: src/shared/doodle.ts.
import { DOODLE, PENCIL_COLORS, inkLife, type Peer, type Stroke } from "../../../shared/doodle.ts";
import { InkLayer, type InkStroke } from "./ink.ts";
import { Clashes } from "./clash.ts";
import { PencilRenderer, type PencilPose } from "./pencils.ts";

/** Others' pencils play back this far behind real time, so batches arriving in bursts come out smooth. */
const DELAY = 140;
const HOVER_Z = 12;
/** the bots' pencils come in one at a time, this long apart (ms), each fading in over FADE_IN_MS (the server waits
 *  that long, hovering, before a bot coming into a room lowers its tip) */
const STAGGER_MS = [1000, 2000] as const;
const FADE_IN_MS = 600;
/** someone who hasn't moved their pencil (or touched the page) for this long goes quiet: the page closes its socket,
 *  giving up its place in the room, and the other pencils fade out over FADE_OUT_MS; the next movement brings it back.
 *  A hidden tab goes quiet after HIDDEN_GRACE_MS. (The room drops a socket without activity for a little longer.) */
const QUIET_MS = 30_000;
const HIDDEN_GRACE_MS = 5_000;
const FADE_OUT_MS = 1000;
/** Where the pencil gives way to the system cursor (app.css gives each of these one). Text blocks count, so their
 *  text can be selected. */
const INTERACTIVE =
  "a, button, input, textarea, select, label, summary, [contenteditable], [role=button], .home-editor, .form-error, .site-footer, .home-hint";
/** Where a finger draws: the blank paper above the fold (app.css gives it touch-action, so one finger draws there and
 *  two scroll or zoom); below it, touch scrolls as usual. */
const PAPER = ".home-hero";
const TILT = 0.88;
const AZIMUTH = 1.02;
/** with a finger, the tip is this far (px, at pencil scale 1) up the pencil from where you touch, so you hold the
 *  pencil and see its tip: the ink comes out of the tip */
const REACH = 38;
/** a touch stroke isn't sent until it's this old (ms): a second finger landing first makes it a scroll, not a mark */
const TOUCH_GRACE = 110;
/** how long your pencil stays after your finger lifts (ms) */
const TOUCH_LINGER = 900;
/** remote pencils' tips stay this far inside your window (px) */
const EDGE = 14;

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  h?: boolean;
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
  /** coming in (see enter): t is seconds since */
  private ent: { t: number; dur: number; dy: number; dz: number; amp: number; w: number; zeta: number; landed: number } | null = null;
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

  /** Come in: a short drop straight down onto where it is (a few px), with a very slight wobble (about 2°, settling
   *  in a swing or two) and the faintest settle when its tip touches the paper. Only how it's drawn: where its tip is
   *  stays the server's. Bots differ only a little, in timing and amplitude. */
  enter() {
    const r = Math.random;
    this.ent = { t: 0, dur: 0.5 + r() * 0.2, dy: -(6 + r() * 4), dz: 20 + r() * 10, amp: 0.024 + r() * 0.01, w: Math.PI * 2 * (1.8 + r() * 0.4), zeta: 3.5 + r() * 1, landed: -1 };
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

  /** Pushed out of another pencil's way. */
  nudge(dx: number, dy: number) {
    this.kx += dx;
    this.ky += dy;
  }

  update(dt: number, tx: number, ty: number, tz: number) {
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
    // coming in: the tip touches the paper (the server lowers it) for the first time once it has drifted in
    const e = this.ent;
    if (e) {
      e.t += dt;
      if (e.landed < 0 && e.t > e.dur * 0.8 && this.z < 2) e.landed = e.t;
      if (e.t > 3) this.ent = null;
    }
  }

  get settled() {
    return (
      !this.dropping &&
      !this.ent &&
      Math.abs(this.zv) < 1 &&
      Math.hypot(this.ovx, this.ovy) < 0.01 &&
      Math.hypot(this.vx, this.vy) < 2 &&
      Math.hypot(this.kx, this.ky) < 0.3 &&
      Math.hypot(this.kvx, this.kvy) < 2 &&
      this.shake === 0
    );
  }

  pose(ox: number, oy: number): PencilPose {
    const s = Math.sin(TILT);
    // shaken across its length
    const j = Math.sin(this.shakePhase) * this.shake;
    const a = this.anchored ? 0 : 1;
    // side to side (across the pencil's lean): where a rock tips its axis (about the tip: the tip doesn't move)
    const px = -Math.sin(AZIMUTH);
    const py = Math.cos(AZIMUTH);
    let [dy, dz, rock, lean] = [0, 0, 0, 0];
    const e = this.ent;
    if (e) {
      // a short drop, easing out
      const back = (1 - Math.min(1, e.t / e.dur)) ** 2;
      dy = e.dy * back;
      dz = e.dz * back;
      // a very slight wobble that dies away (radians: the axis has unit length)
      rock = e.amp * Math.exp(-e.zeta * e.t) * Math.sin(e.w * e.t);
      // touching the paper: the faintest settle (under a degree), gone at once
      if (e.landed >= 0) lean = 0.014 * Math.exp(-14 * (e.t - e.landed)) * Math.sin(Math.min(Math.PI, (e.t - e.landed) * 18));
    }
    const lx = Math.cos(AZIMUTH);
    const ly = Math.sin(AZIMUTH);
    return {
      x: ox + this.x + (this.kx + j * 2.2) * a,
      y: oy + this.y + (this.ky - j * 1.3) * a + dy,
      z: this.z + dz,
      ax: s * Math.cos(AZIMUTH) + this.ox + j * 0.05 + rock * px + lean * lx,
      ay: s * Math.sin(AZIMUTH) + this.oy + rock * py + lean * ly,
      az: Math.cos(TILT),
      roll: this.roll + this.ox * 0.6 + j * 0.5,
      scale: this.scale,
      color: this.color,
    };
  }
}

interface Remote {
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
  /** left (or we went quiet): fading out, then removed */
  gone?: boolean;
  /** fading in or out: its opacity goes from `from` to `to` over `ms` from `t0` (then it's done: gone, if out) */
  fade?: { from: number; to: number; t0: number; ms: number };
}

/** A remote pencil's opacity now (1 when it isn't fading), and whether it's still fading. */
function fadeAt(r: Remote, now: number): { alpha: number; fading: boolean } {
  const f = r.fade;
  if (!f) return { alpha: 1, fading: false };
  const u = Math.min(1, Math.max(0, (now - f.t0) / f.ms));
  return { alpha: f.from + (f.to - f.from) * u * u * (3 - 2 * u), fading: u < 1 };
}

/** Mount the doodle on the home page's root; returns its teardown. */
export function mountDoodle(app: HTMLElement): () => void {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
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

  const remotes = new Map<string, Remote>();
  /** reduced motion: strokes held back until they're finished, by stroke id */
  const pendingReduced = new Map<string, { u: string; s: InkStroke; pts: number[] }>();
  let me: Peer | null = null;
  /** your pencil: with working 3D pencils (drawing needs it). A mouse or pen moves it around; a finger brings it out
   *  on the paper while it draws. */
  // our colour, picked here once (kept for the tab's life): the server takes it as it is, so it never changes
  const myColor = pickColor();
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

  // ---- network ----
  let ws: WebSocket | null = null;
  let retry = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // the room we're in (the server shares people out a few to a room) and our place there: a dropped socket asks for
  // them back; a full room (4409) means ask again, for another
  let room = "";
  let slot = "";
  let fullTries = 0;
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  // quiet: no socket at all, until the next movement
  let quiet = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;

  /** The visitor did something: put off going quiet; back from quiet: (re)join a room (the pencil never left). */
  let saidActive = 0;
  function active() {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(goQuiet, QUIET_MS);
    // (the room counts pencil moves and drawing as activity; scrolling or reading on a phone sends neither: say so)
    const t = performance.now();
    if (!quiet && t - saidActive > 10_000 && ws?.readyState === 1) {
      saidActive = t;
      send({ t: "a" });
    }
    if (!quiet) return;
    quiet = false;
    connect();
  }

  function goQuiet() {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = null;
    if (quiet) return;
    quiet = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    // (the close fades everyone else out: see onclose)
    if (ws) ws.close(1000, "quiet");
  }

  /** A pencil leaves the page: it fades out (one not showing just goes). */
  function fadeOut(id: string) {
    const r = remotes.get(id);
    if (!r) return;
    if (!r.pencil.visible) return removeRemote(id);
    const t0 = performance.now() - DELAY;
    r.gone = true;
    r.fade = { from: fadeAt(r, t0).alpha, to: 0, t0, ms: FADE_OUT_MS };
    wake();
  }
  const send = (m: unknown) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

  function connect() {
    if (ws || document.hidden || quiet) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const q = new URLSearchParams({ color: myColor });
    if (room && slot) [q.set("room", room), q.set("slot", slot)];
    const sock = new WebSocket(`${proto}//${location.host}/ws/home?${q}`);
    ws = sock;
    sock.onmessage = (e) => {
      try {
        onMessage(JSON.parse(String(e.data)));
      } catch (err) {
        console.warn("doodle: bad message", err);
      }
      wake();
    };
    sock.onopen = () => {
      retry = 0;
      sentView = "";
      sendView();
    };
    sock.onclose = (e) => {
      if (ws !== sock) return;
      ws = null;
      if (e.code === 4409) {
        // that room filled up: straight back, for another (backing off if it keeps happening)
        room = slot = "";
        for (const id of [...remotes.keys()]) removeRemote(id);
        retryTimer = setTimeout(() => ((retryTimer = null), connect()), 100 * 2 ** Math.min(fullTries++, 8));
        return;
      }
      // everyone else fades out (their ink stays, and fades as it does)
      for (const id of [...remotes.keys()]) fadeOut(id);
      for (const sid of [...pendingReduced.keys()]) flushPending(sid);
      if (quiet || (e.code === 1000 && document.hidden)) return;
      const wait = e.code === 4429 || e.code === 4403 || e.code === 1008 ? 60_000 : Math.min(30_000, 1000 * 2 ** retry++);
      retryTimer = setTimeout(() => ((retryTimer = null), connect()), wait);
    };
  }

  /** Tell the server how much paper we see (the bots keep to it): the window's width, and its height down to the
   *  bottom of the blank paper. */
  let sentView = "";
  function sendView() {
    if (ws?.readyState !== 1) return;
    const bottom = paper ? paper.offsetTop + paper.offsetHeight : vh;
    const w = Math.round(vw);
    const h = Math.round(Math.min(vh, bottom));
    const v = `${w},${h}`;
    if (v === sentView) return;
    sentView = v;
    send({ t: "v", w, h });
  }

  function addRemote(peer: Peer, drop: boolean) {
    if (remotes.has(peer.id) || peer.id === me?.id) return;
    const label = document.createElement("div");
    label.className = "doodle-label";
    label.style.setProperty("--c", peer.color);
    label.textContent = peer.name;
    if (peer.bot) label.append(Object.assign(document.createElement("span"), { textContent: "agent" }));
    label.hidden = true;
    labels.append(label);
    const r: Remote = { peer, pencil: new Pencil(peer.color, 1.12), samples: [], ink: [], label, lw: 0, lastT: 0, lx: NaN, ly: NaN, lHidden: true };
    remotes.set(peer.id, r);
    if (peer.x !== undefined && peer.y !== undefined) {
      r.pencil.place(peer.x, peer.y, drop && !reduced);
      r.pencil.visible = true;
    }
  }

  function removeRemote(id: string) {
    const r = remotes.get(id);
    if (!r) return;
    // what was still waiting to be played back goes on the page now
    const now = performance.now();
    for (const q of r.ink) ink.push(q.s, [q.x, q.y, q.p], now);
    for (const [sid, b] of pendingReduced) if (b.u === id) flushPending(sid);
    r.label.remove();
    remotes.delete(id);
  }

  function flushPending(sid: string) {
    const b = pendingReduced.get(sid);
    pendingReduced.delete(sid);
    // the whole stroke shows up now, and fades away together
    if (b) ink.push(b.s, b.pts, performance.now());
  }

  // ---- the bots come in one at a time, calmly ----
  // Whenever the page (re)connects, the bots' pencils are kept back and brought in one after another: ones already
  // in the room 1-2 s apart (the first straight away), ones the room is just bringing in as it does (it staggers them
  // itself). Each only while it's between lines (the server says so: `g`), so a pencil never pops up mid-stroke: it
  // fades in, hovering where its next line starts (or resting), then lowers its tip, waits and writes. Their ink isn't
  // kept back: what's on the page shows straight away, and what they write meanwhile goes on as it comes.
  const held = new Map<string, { at: number; x?: number; y?: number; z: number; between: boolean; hidden: boolean }>();
  const revealTimers: ReturnType<typeof setTimeout>[] = [];

  function holdBots(peers: (Peer & { z?: number; g?: number; in?: number })[]) {
    held.clear();
    for (const t of revealTimers.splice(0)) clearTimeout(t);
    const now = performance.now();
    const bots = peers.filter((p) => p.bot).sort(() => Math.random() - 0.5);
    let next = now;
    for (const p of bots) {
      let at: number;
      if (p.in) at = now + p.in;
      else {
        at = next;
        next += STAGGER_MS[0] + Math.random() * (STAGGER_MS[1] - STAGGER_MS[0]);
      }
      held.set(p.id, { at, x: p.x, y: p.y, z: p.z ?? HOVER_Z, between: !!p.g, hidden: false });
      revealTimers.push(setTimeout(() => reveal(p.id), at - now));
    }
  }

  /** Bring a held bot's pencil in, if its turn has come and it's between lines (else a later message will). */
  function reveal(id: string) {
    const h = held.get(id);
    const r = remotes.get(id);
    if (!h || !r || performance.now() < h.at || !h.between || h.x === undefined || h.y === undefined) return;
    held.delete(id);
    const t = Math.max(performance.now(), r.lastT);
    r.lastT = t;
    r.samples = [h.hidden ? { t, x: h.x, y: h.y, z: h.z, h: true } : { t, x: h.x, y: h.y, z: h.z }];
    r.fade = { from: 0, to: 1, t0: t, ms: reduced ? FADE_IN_MS : 350 };
    // (and drops in, with a very slight wobble, unless motion is reduced: then it just fades in)
    if (!reduced) r.pencil.enter();
    wake();
  }

  /** What a held bot does: its pencil stays out of sight (noting where it is); its ink goes on the page as it comes. */
  function heldMessage(h: NonNullable<ReturnType<typeof held.get>>, m: Record<string, any>, now: number) {
    if (m.t === "c") {
      h.hidden = !!m.h;
      if (!m.h) [h.x, h.y, h.z, h.between] = [m.x, m.y, typeof m.z === "number" ? m.z : HOVER_Z, !!m.g];
      return reveal(m.id);
    }
    const p = m.p as number[];
    h.between = false;
    const { life, fade } = inkLife(m.u);
    const st = ink.add(`s${m.id}`, m.c, m.w, now, life, fade);
    if (reduced) {
      const b = pendingReduced.get(`s${m.id}`) ?? { u: m.u as string, s: st, pts: [] as number[] };
      for (const v of p) b.pts.push(v);
      pendingReduced.set(`s${m.id}`, b);
      if (m.e) flushPending(`s${m.id}`);
    } else ink.push(st, p, now);
    if (p.length) [h.x, h.y, h.z] = [p[p.length - 3]!, p[p.length - 2]!, 0];
  }

  /** A stroke from the server's snapshot onto the page, each batch as old as it is (reduced motion: with its last). */
  function pushSnapshot(s: Stroke, now: number, d: number) {
    const { life, fade } = inkLife(s.u);
    const st = ink.add(`s${s.id}`, s.c, s.w, now, life, fade);
    let off = 0;
    let newest = Infinity;
    for (let j = 1; j < s.b.length; j += 2) newest = Math.min(newest, s.b[j]!);
    for (let j = 0; j + 1 < s.b.length; j += 2) {
      const n = s.b[j]!;
      ink.push(st, s.p.slice(off * 3, (off + n) * 3), now - d - (reduced ? newest : s.b[j + 1]!));
      off += n;
    }
  }

  function onMessage(m: Record<string, any>) {
    const now = performance.now();
    // a bot whose pencil hasn't come in yet
    const h = held.get(m.t === "s" ? m.u : m.t === "c" ? m.id : "");
    if (h) return heldMessage(h, m, now);
    if (m.t === "hi") {
      const was = me?.id;
      if (typeof m.room === "string" && typeof m.slot === "string") [room, slot, fullTries] = [m.room, m.slot, 0];
      me = m.you as Peer;
      // (and on every reconnect: the room may be another one, and its bots come in the same way)
      holdBots(m.peers as Peer[]);
      // (the last room's pencils, still fading out, go now)
      for (const r of [...remotes.values()]) if (r.gone) removeRemote(r.peer.id);
      for (const p of m.peers as Peer[]) addRemote(held.has(p.id) ? { ...p, x: undefined, y: undefined } : p, true);
      // a reconnect: the server's copy replaces everything on the page (our own strokes included), except the
      // stroke we're drawing right now (the server has the part we sent before the connection dropped: skip that)
      const strokes = m.strokes as Stroke[];
      const keep = drawing && localStroke ? `me${strokeKey}` : undefined;
      const cut = keep && was ? Math.max(-1, ...strokes.filter((s) => s.u === was).map((s) => s.id)) : -1;
      pendingReduced.clear();
      ink.reset(keep);
      // each batch of points as old as it is for everyone else (reduced motion: the stroke goes with its last batch)
      const d = typeof m.d === "number" ? m.d : 0;
      for (const s of strokes) {
        if (s.id === cut || !Array.isArray(s.b)) continue;
        pushSnapshot(s, now, d);
      }
    } else if (m.t === "j") for (const p of m.peers as Peer[]) addRemote(p, true);
    else if (m.t === "l") for (const id of m.ids as string[]) fadeOut(id);
    else if (m.t === "c") {
      const r = remotes.get(m.id);
      if (!r) return;
      const t = Math.max(now, r.lastT);
      r.lastT = t;
      const sample = m.h ? { t, x: r.pencil.x, y: r.pencil.y, z: HOVER_Z, h: true } : { t, x: m.x, y: m.y, z: typeof m.z === "number" ? m.z : HOVER_Z };
      // nothing plays back in a hidden tab: keep just where the pencil is
      if (document.hidden) r.samples = [sample];
      else r.samples.push(sample);
    } else if (m.t === "s") {
      const sid = `s${m.id}`;
      const r = remotes.get(m.u);
      const p = m.p as number[];
      const n = p.length / 3;
      const { life, fade } = inkLife(m.u);
      const st = ink.add(sid, m.c, m.w, now, life, fade);
      if (reduced) {
        // no pencil to follow: show the stroke when it's finished
        const b = pendingReduced.get(sid) ?? { u: m.u as string, s: st, pts: [] as number[] };
        for (const v of p) b.pts.push(v);
        pendingReduced.set(sid, b);
        if (m.e) flushPending(sid);
        return;
      }
      if (!r || document.hidden) {
        // nobody to follow, or nobody watching: straight onto the page (after what was waiting to be played back)
        if (r) for (const q of r.ink.splice(0)) ink.push(q.s, [q.x, q.y, q.p], now);
        ink.push(st, p, now);
        if (r && n) r.samples = [{ t: Math.max(now, r.lastT), x: p[p.length - 3]!, y: p[p.length - 2]!, z: m.e ? HOVER_Z : 0 }];
        return;
      }
      // spread the batch over the interval it was drawn in, and move the pencil along it
      for (let i = 0; i < n; i++) {
        const t = Math.max(r.lastT, now - DOODLE.batchMs + ((i + 1) * DOODLE.batchMs) / n);
        r.lastT = t;
        const x = p[i * 3]!;
        const y = p[i * 3 + 1]!;
        r.ink.push({ t, s: st, x, y, p: p[i * 3 + 2]! });
        r.samples.push({ t, x, y, z: 0 });
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
  /** some of this stroke went to the server */
  let sentAny = false;
  /** fingers down that started on the paper */
  const touches = new Map<number, { x: number; y: number }>();
  let panMid: { x: number; y: number } | null = null;
  let lingerTimer: ReturnType<typeof setTimeout> | null = null;
  let strokeKey = 0;
  let localStroke: ReturnType<typeof ink.add> | null = null;
  let outbox: number[] = [];
  let lastFlush = 0;
  let cursorDirty = false;
  let lastCursor = 0;
  let hiddenSent = true;
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
    outbox.push(...q);
  }

  function flushOutbox(end: boolean) {
    while (outbox.length || end) {
      const chunk = outbox.splice(0, DOODLE.maxPointsPerMessage * 3);
      const last = outbox.length === 0;
      if (chunk.length || (end && last)) {
        send({ t: "s", k: strokeKey, p: chunk, ...(end && last ? { e: 1 } : {}) });
        sentAny = true;
      }
      if (last) break;
    }
    lastFlush = performance.now();
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
    outbox = [];
    lastPt = null;
    pressure = 0.55;
    strokeStart = performance.now();
    sentAny = false;
    localStroke = ink.add(`me${strokeKey}`, myColor, 2.2, strokeStart);
    addPoint(e);
    wake();
  }

  /** A second finger came down: it's a scroll or a zoom. A stroke nobody has seen yet goes; one they have ends. */
  function cancelStroke() {
    if (!drawing) return;
    if (!sentAny && localStroke) {
      ink.remove(localStroke.id);
      drawing = false;
      drawId = -1;
      localStroke = null;
      outbox = [];
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
    active();
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
    active();
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
    localStroke = null;
    flushOutbox(true);
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

  const onVisibility = () => {
    if (document.hidden) {
      onUp();
      // nobody looking: quiet after a moment (a quick look elsewhere keeps the place)
      hiddenTimer = setTimeout(goQuiet, HIDDEN_GRACE_MS);
    } else {
      if (hiddenTimer) clearTimeout(hiddenTimer);
      connect();
      wake();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  // names change width when the page's fonts come in: place them again (a parked pencil's loop may be asleep)
  const onFonts = () => {
    for (const r of remotes.values()) r.lx = NaN;
    wake();
  };
  document.fonts?.addEventListener("loadingdone", onFonts);

  /** Tell the others where your pencil is; true when an update is still due (throttled). */
  function sendCursor(now: number): boolean {
    const show = overPage && !overInteractive;
    if (!show) {
      if (!hiddenSent) send({ t: "c", h: 1 });
      hiddenSent = true;
      cursorDirty = false;
      return false;
    }
    if (!cursorDirty || drawing) return false;
    if (now - lastCursor < 50) return true;
    const { x, y } = toPage(px, py);
    send({ t: "c", x: r1(x), y: r1(y) });
    hiddenSent = false;
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
    if (drawing && now - lastFlush >= DOODLE.batchMs && !(touchMode && !sentAny && now - strokeStart < TOUCH_GRACE)) flushOutbox(false);
    let busy = drawing || sendCursor(now);

    const rt = now - DELAY;
    const ox = rect.left + rect.width / 2;
    const oy = rect.top;
    const poses: PencilPose[] = [];
    const bodies: { key: string; pencil: Pencil; pose: PencilPose; color: string }[] = [];
    let animating = false;
    for (const r of remotes.values()) {
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
        if (a.h) r.pencil.visible = false;
        else {
          let x = a.x;
          let y = a.y;
          let z = a.z;
          if (b && !b.h && b.t > a.t) {
            const u = clamp((rt - a.t) / (b.t - a.t), 0, 1);
            x += (b.x - a.x) * u;
            y += (b.y - a.y) * u;
            z += (b.z - a.z) * u;
          }
          if (!r.pencil.isPlaced || !r.pencil.visible) {
            // (one fading in comes in where it is, not dropping in)
            r.pencil.place(x, y, !r.pencil.isPlaced && !reduced && !r.fade);
            r.pencil.visible = true;
          }
          r.pencil.update(dt, x, y, z);
        }
      } else if (r.pencil.visible) r.pencil.update(dt, r.pencil.x, r.pencil.y, HOVER_Z);
      if (r.pencil.visible) {
        r.pencil.scale = 1.12 * pscale;
        const pose = r.pencil.pose(ox, oy);
        // fading in or out (on the playback clock, like its moves)
        const f = fadeAt(r, rt);
        pose.alpha = f.alpha;
        r.label.style.opacity = f.alpha < 1 ? String(f.alpha) : "";
        if (f.fading) busy = true;
        else if (r.fade && r.fade.to <= 0) {
          // faded right out: gone from sight (until it moves again), or gone
          if (r.gone) {
            removeRemote(r.peer.id);
            continue;
          }
          r.fade = undefined;
          r.pencil.visible = false;
          r.samples = [{ t: rt, x: r.pencil.x, y: r.pencil.y, z: HOVER_Z, h: true }];
        } else r.fade = undefined;
        // someone on a wider screen (or a bot) past the side of yours: their pencil waits at the edge
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
        if (!mine.isPlaced) mine.place(x, y, !touchMode);
        mine.visible = true;
        mine.scale = pscale;
        mine.anchored = drawing;
        mine.update(dt, x, y, drawing ? 0 : HOVER_Z);
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
  // (nobody moving from the start goes quiet too)
  quietTimer = setTimeout(goQuiet, QUIET_MS);
  connect();

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    if (idleTimer) clearTimeout(idleTimer);
    if (sizeTimer) clearTimeout(sizeTimer);
    if (retryTimer) clearTimeout(retryTimer);
    if (quietTimer) clearTimeout(quietTimer);
    if (hiddenTimer) clearTimeout(hiddenTimer);
    for (const t of revealTimers) clearTimeout(t);
    ro.disconnect();
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
    const sock = ws;
    ws = null;
    sock?.close(1000);
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

/** This tab's pencil colour: the one it had (a reload keeps it), else one of the palette at random. */
function pickColor(): string {
  const key = "grimoire.pencilColor";
  try {
    const kept = sessionStorage.getItem(key);
    if (kept && PENCIL_COLORS.includes(kept)) return kept;
  } catch {}
  const c = PENCIL_COLORS[Math.floor(Math.random() * PENCIL_COLORS.length)]!;
  try {
    sessionStorage.setItem(key, c);
  } catch {}
  return c;
}
