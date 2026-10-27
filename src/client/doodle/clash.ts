// Pencils bumping into each other: when two pencils' bodies touch, both are knocked away (a wobble, a shake, a little
// hop) and a quick burst of pencil flicks in both colours shows where they hit. Worked out on every client from the
// pencils it shows (people's and bots'), so nothing extra goes over the wire; small differences between clients are fine.
import { PENCIL_LENGTH, type PencilPose } from "./pencils.ts";

export interface ClashBody {
  key: string;
  pose: PencilPose;
  color: string;
  pencil: { vx: number; vy: number; knock(nx: number, ny: number, s: number): void; nudge(dx: number, dy: number): void };
}

interface Burst {
  /** page units */
  x: number;
  y: number;
  t0: number;
  c1: string;
  c2: string;
  seed: number;
  s: number;
}

/** how long an impact burst shows (ms) */
const LIFE = 520;
/** the body's radius (hexagon plus outline) at scale 1 */
const RADIUS = 7.6;
const MAX_BURSTS = 24;

type V3 = [number, number, number];

export class Clashes {
  readonly canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  private bursts: Burst[] = [];
  private pairs = new Map<string, { touch: boolean; last: number }>();
  private drawn = false;
  private w = 0;
  private h = 0;
  private dpr = 1;

  constructor() {
    this.canvas.setAttribute("aria-hidden", "true");
    this.canvas.hidden = true;
    // just under the pencils (.doodle-gl is z-index 30), graphite on paper
    Object.assign(this.canvas.style, { position: "fixed", inset: "0", width: "100vw", height: "100vh", zIndex: "29", pointerEvents: "none", mixBlendMode: "multiply" });
    this.ctx = this.canvas.getContext("2d")!;
  }

  /** Find the pencils touching each other and knock them apart. Poses are in viewport px; (ox, oy) is the page origin. */
  collide(bodies: ClashBody[], now: number, ox: number, oy: number) {
    for (const [k, st] of this.pairs) if (!st.touch && now - st.last > 2000) this.pairs.delete(k);
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const A = bodies[i]!;
        const B = bodies[j]!;
        const a = A.pose;
        const b = B.pose;
        if (Math.abs(a.x - b.x) > 260 || Math.abs(a.y - b.y) > 260) continue;
        const [p1, q1] = segment(a);
        const [p2, q2] = segment(b);
        const [c1, c2] = closest(p1, q1, p2, q2);
        const dist = Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]);
        const contact = RADIUS * (a.scale + b.scale);
        const key = A.key < B.key ? `${A.key}|${B.key}` : `${B.key}|${A.key}`;
        let st = this.pairs.get(key);
        if (dist >= contact) {
          if (st) st.touch = false;
          continue;
        }
        if (!st) this.pairs.set(key, (st = { touch: false, last: -Infinity }));
        // push A away from B along the floor
        let nx = c1[0] - c2[0];
        let ny = c1[1] - c2[1];
        let nl = Math.hypot(nx, ny);
        if (nl < 0.5) {
          nx = a.x - b.x;
          ny = a.y - b.y;
          nl = Math.hypot(nx, ny);
        }
        if (nl < 0.5) {
          nx = A.key < B.key ? 1 : -1;
          ny = 0;
          nl = 1;
        }
        nx /= nl;
        ny /= nl;
        const overlap = contact - dist;
        A.pencil.nudge(nx * overlap * 0.4, ny * overlap * 0.4);
        B.pencil.nudge(-nx * overlap * 0.4, -ny * overlap * 0.4);
        const closing = -((A.pencil.vx - B.pencil.vx) * nx + (A.pencil.vy - B.pencil.vy) * ny);
        if ((!st.touch && now - st.last > 160) || (closing > 500 && now - st.last > 260)) {
          const s = Math.min(1.5, 0.4 + Math.max(0, closing) / 1100);
          A.pencil.knock(nx, ny, s);
          B.pencil.knock(-nx, -ny, s);
          st.last = now;
          this.bursts.push({ x: (c1[0] + c2[0]) / 2 - ox, y: (c1[1] + c2[1]) / 2 - oy, t0: now, c1: A.color, c2: B.color, seed: (Math.random() * 2 ** 31) | 0, s });
          if (this.bursts.length > MAX_BURSTS) this.bursts.shift();
        }
        st.touch = true;
      }
    }
  }

  /** Draw the bursts still showing; true while there are any. */
  draw(now: number, ox: number, oy: number, w: number, h: number): boolean {
    if (this.bursts.length) this.bursts = this.bursts.filter((b) => now - b.t0 < LIFE);
    if (!this.bursts.length && !this.drawn) return false;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (w !== this.w || h !== this.h || dpr !== this.dpr) {
      this.w = w;
      this.h = h;
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.bursts.length) {
      if (this.canvas.hidden) this.canvas.hidden = false;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const b of this.bursts) burst(ctx, b, (now - b.t0) / LIFE, ox + b.x, oy + b.y);
      ctx.globalAlpha = 1;
      this.drawn = true;
    } else {
      this.canvas.hidden = true;
      this.drawn = false;
    }
    return this.drawn;
  }
}

/** A star burst of short pencil flicks flying out from the hit, plus a little zigzag, fading fast. */
function burst(ctx: CanvasRenderingContext2D, b: Burst, k: number, cx: number, cy: number) {
  const rnd = rng(b.seed);
  const fade = (1 - k) ** 1.6;
  const out = 1 - (1 - k) ** 3;
  const n = 6 + Math.round(b.s * 2);
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + rnd() * 0.6;
    const r0 = 5 + 15 * out * (0.8 + rnd() * 0.4);
    const len = (8 + rnd() * 10) * (0.8 + 0.35 * b.s) * (1 - 0.55 * k);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    ctx.strokeStyle = i % 2 ? b.c1 : b.c2;
    // drawn twice, a hair apart, like a quick pencil flick (heavy at the start, trailing off)
    for (let pass = 0; pass < 2; pass++) {
      const jx = (rnd() - 0.5) * 0.9;
      const jy = (rnd() - 0.5) * 0.9;
      ctx.globalAlpha = fade * (pass ? 0.45 : 0.85);
      ctx.lineWidth = pass ? 1 : 1.9;
      ctx.beginPath();
      ctx.moveTo(cx + ca * r0 + jx, cy + sa * r0 + jy);
      ctx.quadraticCurveTo(cx + ca * (r0 + len * 0.5) - sa * 1.5 + jx, cy + sa * (r0 + len * 0.5) + ca * 1.5 + jy, cx + ca * (r0 + len) + jx, cy + sa * (r0 + len) + jy);
      ctx.stroke();
    }
  }
  // a tiny cartoon zigzag over the spot
  ctx.strokeStyle = b.c1;
  ctx.globalAlpha = fade * 0.7;
  ctx.lineWidth = 1.3;
  const zr = 6 + 5 * out;
  const za = rnd() * Math.PI;
  ctx.beginPath();
  for (let i = 0; i <= 4; i++) {
    const u = i / 4 - 0.5;
    const off = i % 2 ? zr * 0.45 : -zr * 0.45;
    const x = cx + Math.cos(za) * u * zr * 2 - Math.sin(za) * off;
    const y = cy - zr * 1.6 + Math.sin(za) * u * zr * 2 + Math.cos(za) * off;
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.stroke();
}

/** The pencil's body as a segment, from just above the point to near the eraser. */
function segment(p: PencilPose): [V3, V3] {
  const l = Math.hypot(p.ax, p.ay, p.az) || 1;
  const ax = p.ax / l;
  const ay = p.ay / l;
  const az = p.az / l;
  const a = 8 * p.scale;
  const b = PENCIL_LENGTH * 0.95 * p.scale;
  return [
    [p.x + ax * a, p.y + ay * a, p.z + az * a],
    [p.x + ax * b, p.y + ay * b, p.z + az * b],
  ];
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const at = (p: V3, d: V3, t: number): V3 => [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t];
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** The closest points of segments p1q1 and p2q2. */
function closest(p1: V3, q1: V3, p2: V3, q2: V3): [V3, V3] {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  const c = dot(d1, r);
  const b = dot(d1, d2);
  const denom = a * e - b * b;
  let s = denom > 1e-6 * a * e ? clamp01((b * f - c * e) / denom) : 0;
  let t = (b * s + f) / e;
  if (t < 0) {
    t = 0;
    s = clamp01(-c / a);
  } else if (t > 1) {
    t = 1;
    s = clamp01((b - c) / a);
  }
  return [at(p1, d1, s), at(p2, d2, t)];
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
