// The home page doodle: your cursor is a 3D pencil that draws on the page, and you see everyone else's pencils
// (people and the server's bots) and drawings live over /ws/home. Loaded lazily by the home page only.
// Protocol and page units: src/shared/doodle.ts.
import { DOODLE, type Peer, type Stroke } from "../../shared/doodle.ts";
import { InkLayer } from "./ink.ts";
import { PencilRenderer, type PencilPose } from "./pencils.ts";

/** Others' pencils play back this far behind real time, so batches arriving in bursts come out smooth. */
const DELAY = 140;
const HOVER_Z = 12;
const INTERACTIVE = "a, button, input, textarea, select, label, summary, [contenteditable], [role=button], .home-editor, .home-cta";
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
  sid: string;
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
  private vx = 0;
  private vy = 0;
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
  }

  get settled() {
    return !this.dropping && Math.abs(this.zv) < 1 && Math.hypot(this.ovx, this.ovy) < 0.01 && Math.hypot(this.vx, this.vy) < 2;
  }

  pose(ox: number, oy: number): PencilPose {
    const s = Math.sin(TILT);
    return {
      x: ox + this.x,
      y: oy + this.y,
      z: this.z,
      ax: s * Math.cos(AZIMUTH) + this.ox,
      ay: s * Math.sin(AZIMUTH) + this.oy,
      az: Math.cos(TILT),
      roll: this.roll + this.ox * 0.6,
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
}

export function mountDoodle(app: HTMLElement) {
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

  const remotes = new Map<string, Remote>();
  /** strokes still being drawn by someone: stroke id → owner */
  const pendingReduced = new Map<string, InkPt[]>();
  let me: Peer | null = null;
  let mine: Pencil | null = null;

  // ---- page geometry ----
  let rect = app.getBoundingClientRect();
  const sizeInk = () => ink.resize(app.clientWidth, Math.max(app.scrollHeight, window.innerHeight));
  const ro = new ResizeObserver(sizeInk);
  ro.observe(app);
  sizeInk();
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
    };
    sock.onopen = () => (retry = 0);
    sock.onclose = (e) => {
      if (ws !== sock) return;
      ws = null;
      for (const id of [...remotes.keys()]) removeRemote(id);
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
    labels.append(label);
    const r: Remote = { peer, pencil: new Pencil(peer.color, 1.12), samples: [], ink: [], label, lastT: 0 };
    remotes.set(peer.id, r);
    if (peer.x !== undefined && peer.y !== undefined) {
      r.pencil.place(peer.x, peer.y, drop && !reduced);
      r.pencil.visible = true;
    }
  }

  function removeRemote(id: string) {
    const r = remotes.get(id);
    if (!r) return;
    r.label.remove();
    remotes.delete(id);
  }

  function inkStroke(id: number, color: string, w: number, t0: number) {
    return ink.add(`s${id}`, color, w, t0);
  }

  function onMessage(m: Record<string, any>) {
    const now = performance.now();
    if (m.t === "hi") {
      me = m.you as Peer;
      if (mine) mine.color = hex(me.color);
      else if (finePointer && renderer) mine = new Pencil(me.color, 1);
      for (const p of m.peers as Peer[]) addRemote(p, true);
      for (const s of m.strokes as Stroke[]) {
        const st = inkStroke(s.id, s.c, s.w, now - s.a);
        st.p = s.p.slice();
      }
    } else if (m.t === "j") addRemote(m as unknown as Peer, true);
    else if (m.t === "l") removeRemote(m.id);
    else if (m.t === "c") {
      const r = remotes.get(m.id);
      if (!r) return;
      const t = Math.max(now, r.lastT);
      r.lastT = t;
      r.samples.push(m.h ? { t, x: r.pencil.x, y: r.pencil.y, z: HOVER_Z, h: true } : { t, x: m.x, y: m.y, z: typeof m.z === "number" ? m.z : HOVER_Z });
    } else if (m.t === "s") {
      const sid = `s${m.id}`;
      const r = remotes.get(m.u);
      const p = m.p as number[];
      const n = p.length / 3;
      if (!ink.strokes.has(sid)) inkStroke(m.id, m.c, m.w, now);
      if (reduced || !r) {
        // no pencil to follow: show the stroke when it's finished (reduced motion) or right away
        const buf = pendingReduced.get(sid) ?? [];
        for (let i = 0; i < n; i++) buf.push({ t: 0, sid, x: p[i * 3]!, y: p[i * 3 + 1]!, p: p[i * 3 + 2]! });
        if (m.e || !reduced) {
          const st = ink.strokes.get(sid)!;
          for (const q of buf) st.p.push(q.x, q.y, q.p);
          pendingReduced.delete(sid);
        } else pendingReduced.set(sid, buf);
        return;
      }
      // spread the batch over the interval it was drawn in, and move the pencil along it
      for (let i = 0; i < n; i++) {
        const t = Math.max(r.lastT, now - DOODLE.batchMs + ((i + 1) * DOODLE.batchMs) / n);
        r.lastT = t;
        const x = p[i * 3]!;
        const y = p[i * 3 + 1]!;
        r.ink.push({ t, sid, x, y, p: p[i * 3 + 2]! });
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

  const isInteractive = (el: EventTarget | null) => el instanceof Element && !!el.closest(INTERACTIVE);
  if (finePointer && renderer) app.classList.add("doodle-on");

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
    localStroke?.p.push(...q);
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
      for (const ce of e.getCoalescedEvents?.() ?? [e]) addPoint(ce);
    } else cursorDirty = true;
  };
  const onDown = (e: PointerEvent) => {
    if (e.pointerType === "touch" || e.button !== 0 || isInteractive(e.target)) return;
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    drawing = true;
    app.classList.add("doodling");
    strokeKey++;
    outbox = [];
    lastPt = null;
    pressure = 0.55;
    localStroke = ink.add(`me${strokeKey}`, me?.color ?? "#4a4f57", 2.2, performance.now());
    addPoint(e);
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
  };
  document.addEventListener("pointermove", onMove, { passive: true });
  document.addEventListener("pointerdown", onDown);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
  document.addEventListener("pointerout", onLeave);
  window.addEventListener("blur", onUp);

  const onVisibility = () => {
    if (document.hidden) {
      onUp();
      // let the server rest (and pause its bots) when nobody is looking
      hiddenTimer = setTimeout(() => ws?.close(1000, "hidden"), 60_000);
    } else {
      if (hiddenTimer) clearTimeout(hiddenTimer);
      connect();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  function sendCursor(now: number) {
    const show = overPage && !overInteractive && finePointer;
    if (!show) {
      if (!hiddenSent) send({ t: "c", h: 1 });
      hiddenSent = true;
      cursorDirty = false;
      return;
    }
    if (!cursorDirty || now - lastCursor < 50 || drawing) return;
    const { x, y } = toPage(px, py);
    send({ t: "c", x: r1(x), y: r1(y) });
    hiddenSent = false;
    cursorDirty = false;
    lastCursor = now;
  }

  // ---- frame loop ----
  let last = performance.now();
  let raf = 0;
  let glDirty = true;
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dt = clamp((now - last) / 1000, 0.001, 0.05);
    last = now;
    rect = app.getBoundingClientRect();
    if (drawing && now - lastFlush >= DOODLE.batchMs) flushOutbox(false);
    sendCursor(now);

    const rt = now - DELAY;
    const ox = rect.left + rect.width / 2;
    const oy = rect.top;
    const poses: PencilPose[] = [];
    let animating = false;
    for (const r of remotes.values()) {
      while (r.ink.length && r.ink[0]!.t <= rt) {
        const q = r.ink.shift()!;
        ink.strokes.get(q.sid)?.p.push(q.x, q.y, q.p);
      }
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
        if (on) poses.push(pose);
        if (on && !r.pencil.settled) animating = true;
        r.label.style.transform = `translate(${Math.round(pose.x + 12)}px, ${Math.round(pose.y - pose.z * 0.3 - 30)}px)`;
        r.label.hidden = !on;
      } else r.label.hidden = true;
    }
    if (mine) {
      const show = overPage && !overInteractive;
      if (show) {
        const { x, y } = toPage(px, py);
        if (!mine.isPlaced) mine.place(x, y, true);
        mine.visible = true;
        mine.update(dt, x, y, drawing ? 0 : HOVER_Z);
        poses.push(mine.pose(ox, oy));
        if (!mine.settled) animating = true;
      } else if (mine.visible) {
        mine.visible = false;
        animating = true;
      }
    }
    ink.flush(now);
    // how many pencils are on screen (for tests)
    if (String(poses.length) !== app.dataset.pencils) app.dataset.pencils = String(poses.length);
    if (renderer && glCanvas) {
      if (poses.length || glDirty) {
        renderer.resize(innerWidth, innerHeight, Math.min(devicePixelRatio || 1, 2));
        renderer.render(poses);
      }
      glDirty = poses.length > 0 || animating;
    }
  }
  raf = requestAnimationFrame(frame);
  connect();

  return () => {
    cancelAnimationFrame(raf);
    if (retryTimer) clearTimeout(retryTimer);
    if (hiddenTimer) clearTimeout(hiddenTimer);
    ro.disconnect();
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerdown", onDown);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    document.removeEventListener("pointerout", onLeave);
    window.removeEventListener("blur", onUp);
    document.removeEventListener("visibilitychange", onVisibility);
    const sock = ws;
    ws = null;
    sock?.close(1000);
    app.classList.remove("doodle-on", "doodling");
    delete app.dataset.pencils;
    ink.canvas.remove();
    labels.remove();
    glCanvas?.remove();
  };
}
