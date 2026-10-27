// The home page doodle: your cursor is a 3D pencil that draws on the page, and you see everyone else's pencils
// (people and the server's bots) and drawings live over /ws/home. Loaded lazily by the home page only.
// Protocol and page units: src/shared/doodle.ts.
import { DOODLE, type Peer, type Stroke } from "../../shared/doodle.ts";
import { InkLayer, type InkStroke } from "./ink.ts";
import { Clashes } from "./clash.ts";
import { PencilRenderer, type PencilPose } from "./pencils.ts";

/** Others' pencils play back this far behind real time, so batches arriving in bursts come out smooth. */
const DELAY = 140;
const HOVER_Z = 12;
/** Where the pencil gives way to the system cursor (app.css gives each of these one). Text blocks count, so their
 *  text can be selected. */
const INTERACTIVE =
  "a, button, input, textarea, select, label, summary, [contenteditable], [role=button], .home-editor, .home-caption, .home-about, .form-error";
const TILT = 0.88;
const AZIMUTH = 1.02;

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
  color: [number, number, number];

  constructor(
    color: string,
    readonly scale: number,
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
      this.shake === 0
    );
  }

  pose(ox: number, oy: number): PencilPose {
    const s = Math.sin(TILT);
    // shaken across its length
    const j = Math.sin(this.shakePhase) * this.shake;
    return {
      x: ox + this.x + this.kx + j * 2.2,
      y: oy + this.y + this.ky - j * 1.3,
      z: this.z,
      ax: s * Math.cos(AZIMUTH) + this.ox + j * 0.05,
      ay: s * Math.sin(AZIMUTH) + this.oy,
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
  lastT: number;
  lx: number;
  ly: number;
  lHidden: boolean;
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
  /** your pencil: only with a mouse (or pen) and working 3D pencils; drawing needs it */
  const mine = finePointer && renderer ? new Pencil("#4a4f57", 1) : null;

  // ---- page geometry ----
  let rect = app.getBoundingClientRect();
  let rectDirty = false;
  const updateRect = () => {
    if (!rectDirty) return;
    rectDirty = false;
    rect = app.getBoundingClientRect();
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

  // ---- network ----
  let ws: WebSocket | null = null;
  let retry = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  const send = (m: unknown) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

  function connect() {
    if (ws || document.hidden) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const sock = new WebSocket(`${proto}//${location.host}/ws/home`);
    ws = sock;
    sock.onmessage = (e) => {
      try {
        onMessage(JSON.parse(String(e.data)));
      } catch (err) {
        console.warn("doodle: bad message", err);
      }
      wake();
    };
    sock.onopen = () => (retry = 0);
    sock.onclose = (e) => {
      if (ws !== sock) return;
      ws = null;
      for (const id of [...remotes.keys()]) removeRemote(id);
      for (const sid of [...pendingReduced.keys()]) flushPending(sid);
      if (e.code === 1000 && document.hidden) return;
      const wait = e.code === 4429 || e.code === 4403 || e.code === 1008 ? 60_000 : Math.min(30_000, 1000 * 2 ** retry++);
      retryTimer = setTimeout(() => ((retryTimer = null), connect()), wait);
    };
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
    const r: Remote = { peer, pencil: new Pencil(peer.color, 1.12), samples: [], ink: [], label, lastT: 0, lx: NaN, ly: NaN, lHidden: true };
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

  function onMessage(m: Record<string, any>) {
    const now = performance.now();
    if (m.t === "hi") {
      const was = me?.id;
      me = m.you as Peer;
      if (mine) mine.color = hex(me.color);
      for (const p of m.peers as Peer[]) addRemote(p, true);
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
        const st = ink.add(`s${s.id}`, s.c, s.w, now);
        let off = 0;
        let newest = Infinity;
        for (let j = 1; j < s.b.length; j += 2) newest = Math.min(newest, s.b[j]!);
        for (let j = 0; j + 1 < s.b.length; j += 2) {
          const n = s.b[j]!;
          ink.push(st, s.p.slice(off * 3, (off + n) * 3), now - d - (reduced ? newest : s.b[j + 1]!));
          off += n;
        }
      }
    } else if (m.t === "j") for (const p of m.peers as Peer[]) addRemote(p, true);
    else if (m.t === "l") for (const id of m.ids as string[]) removeRemote(id);
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
      const st = ink.add(sid, m.c, m.w, now);
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
  let px = 0;
  let py = 0;
  let overPage = false;
  let overInteractive = false;
  let drawing = false;
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
  if (mine) app.classList.add("doodle-on");

  function addPoint(e: PointerEvent) {
    const { x, y } = toPage(e.clientX, e.clientY);
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
      if (chunk.length || (end && last)) send({ t: "s", k: strokeKey, p: chunk, ...(end && last ? { e: 1 } : {}) });
      if (last) break;
    }
    lastFlush = performance.now();
  }

  const onMove = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    px = e.clientX;
    py = e.clientY;
    overPage = true;
    overInteractive = !drawing && isInteractive(e.target);
    if (drawing) {
      updateRect();
      for (const ce of e.getCoalescedEvents?.() ?? [e]) addPoint(ce);
    } else cursorDirty = true;
    wake();
  };
  const onDown = (e: PointerEvent) => {
    // only with your pencil showing: elsewhere (text, controls, touch, no pencil) the page behaves as usual
    if (!mine || e.pointerType === "touch" || e.button !== 0 || isInteractive(e.target)) return;
    e.preventDefault();
    rectDirty = true;
    updateRect();
    (document.activeElement as HTMLElement | null)?.blur?.();
    drawing = true;
    app.classList.add("doodling");
    strokeKey++;
    outbox = [];
    lastPt = null;
    pressure = 0.55;
    localStroke = ink.add(`me${strokeKey}`, me?.color ?? "#4a4f57", 2.2, performance.now());
    addPoint(e);
    wake();
  };
  const onUp = () => {
    if (!drawing) return;
    drawing = false;
    app.classList.remove("doodling");
    localStroke = null;
    flushOutbox(true);
  };
  const onLeave = (e: PointerEvent) => {
    if (e.relatedTarget) return;
    overPage = false;
    onUp();
    wake();
  };
  const onScroll = () => {
    rectDirty = true;
    wake();
  };
  document.addEventListener("pointermove", onMove, { passive: true });
  document.addEventListener("pointerdown", onDown);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
  document.addEventListener("pointerout", onLeave);
  window.addEventListener("blur", onUp);
  window.addEventListener("scroll", onScroll, { passive: true });

  const onVisibility = () => {
    if (document.hidden) {
      onUp();
      // let the server rest (and pause its bots) when nobody is looking
      hiddenTimer = setTimeout(() => ws?.close(1000, "hidden"), 60_000);
    } else {
      if (hiddenTimer) clearTimeout(hiddenTimer);
      connect();
      wake();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  /** Tell the others where your pencil is; true when an update is still due (throttled). */
  function sendCursor(now: number): boolean {
    const show = overPage && !overInteractive && finePointer;
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
    if (drawing && now - lastFlush >= DOODLE.batchMs) flushOutbox(false);
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
            r.pencil.place(x, y, !r.pencil.isPlaced && !reduced);
            r.pencil.visible = true;
          }
          r.pencil.update(dt, x, y, z);
        }
      } else if (r.pencil.visible) r.pencil.update(dt, r.pencil.x, r.pencil.y, HOVER_Z);
      if (r.pencil.visible) {
        const pose = r.pencil.pose(ox, oy);
        const on = pose.x > -260 && pose.x < innerWidth + 60 && pose.y > -260 && pose.y < innerHeight + 60;
        if (on) {
          poses.push(pose);
          bodies.push({ key: r.peer.id, pencil: r.pencil, pose, color: r.peer.color });
          const lx = Math.round(pose.x + 12);
          const ly = Math.round(pose.y - pose.z * 0.3 - 30);
          if (lx !== r.lx || ly !== r.ly) {
            r.lx = lx;
            r.ly = ly;
            r.label.style.transform = `translate(${lx}px, ${ly}px)`;
          }
        }
        if (!r.pencil.settled) animating = true;
        if (r.lHidden !== !on) {
          r.lHidden = !on;
          r.label.hidden = !on;
        }
      } else if (!r.lHidden) {
        r.lHidden = true;
        r.label.hidden = true;
      }
    }
    if (mine) {
      const show = overPage && !overInteractive;
      if (show) {
        const { x, y } = toPage(px, py);
        if (!mine.isPlaced) mine.place(x, y, true);
        mine.visible = true;
        mine.update(dt, x, y, drawing ? 0 : HOVER_Z);
        const pose = mine.pose(ox, oy);
        poses.push(pose);
        bodies.push({ key: "me", pencil: mine, pose, color: me?.color ?? "#4a4f57" });
        if (!mine.settled) animating = true;
      } else if (mine.visible) {
        mine.visible = false;
        animating = true;
      }
    }
    if (clashes) {
      clashes.collide(bodies, now, ox, oy);
      if (clashes.draw(now, ox, oy, innerWidth, innerHeight)) animating = true;
    }
    ink.flush(now);
    // for tests: pencils on screen, whether yours is one, strokes on the page
    if (String(poses.length) !== app.dataset.pencils) app.dataset.pencils = String(poses.length);
    const own = mine?.visible ? "1" : "0";
    if (own !== app.dataset.mine) app.dataset.mine = own;
    if (String(ink.strokes.size) !== app.dataset.ink) app.dataset.ink = String(ink.strokes.size);
    if (renderer && glCanvas) {
      if (poses.length || glDirty) {
        renderer.resize(innerWidth, innerHeight, Math.min(devicePixelRatio || 1, 2));
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
  connect();

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    if (idleTimer) clearTimeout(idleTimer);
    if (sizeTimer) clearTimeout(sizeTimer);
    if (retryTimer) clearTimeout(retryTimer);
    if (hiddenTimer) clearTimeout(hiddenTimer);
    ro.disconnect();
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerdown", onDown);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    document.removeEventListener("pointerout", onLeave);
    window.removeEventListener("blur", onUp);
    window.removeEventListener("scroll", onScroll);
    document.removeEventListener("visibilitychange", onVisibility);
    const sock = ws;
    ws = null;
    sock?.close(1000);
    app.classList.remove("doodle-on", "doodling");
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
