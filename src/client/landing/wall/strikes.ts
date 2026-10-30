// Claw strikes: a hand behind the wall throws its claws at it. Three or four claw tips in a slightly curved row each
// push a sharp point into the plastic (a pointed tent with a shallow trough round it, stamped into material.ts's height
// field), the palm bends the wall a little, a tiny dark slit opens at each tip, a flex wave runs out and the page
// shakes. Everything stays: dents and slits accumulate. Most strikes land around the spot where the hole will open.
import { clamp, gauss, rand, type Batch, type View } from "./core.ts";
import type { Material } from "./material.ts";

export const STRIKE = {
  /** +1: the claws push the plastic out toward you (they're behind it); -1: pressed in from the front */
  direction: 1,
  /** claws per hand */
  claws: [3, 4] as const,
  /** gap between claw tips (px), and how much the row curves (px of sag at the ends) */
  spacing: [24, 34] as const,
  curve: [4, 12] as const,
  /** each tip: peak height (px), length along the claw and width across (px) */
  depth: [6, 10] as const,
  length: [18, 28] as const,
  width: [4, 6.5] as const,
  /** the trough round each tip (fraction of its depth) */
  trough: 0.1,
  /** the palm's bend behind the tips: px of height and radius (px) */
  palm: 1.6,
  palmRadius: 80,
  /** the impact: pushed past its final depth by this much, then settles back over `settle` s */
  overshoot: 0.35,
  punch: 0.06,
  settle: 0.45,
  /** the slit at each tip: length (fraction of the tip's length) and width (px) */
  slitLength: 0.38,
  slitWidth: 1.9,
  /** later strikes go deeper (more likely to slit, longer slits): per strike, up to `maxGrowth` */
  growth: 0.04,
  maxGrowth: 0.6,
  /** fraction of strikes in the cluster (where the hole will be), and its spread (px, one sd) */
  cluster: 0.75,
  spread: 65,
  /** flex wave amplitude (px) and shake (0..1), for a cluster strike; strays are gentler */
  wave: 2.4,
  shake: 1,
};

export interface Puncture {
  x: number;
  y: number;
  /** the claw's direction (radians) */
  a: number;
  len: number;
  w: number;
}

interface Tip {
  x: number;
  y: number;
  a: number;
  depth: number;
  len: number;
  wid: number;
}

interface Strike {
  x: number;
  y: number;
  a: number;
  tips: Tip[];
  t: number;
  /** how much of its stamp is in the field so far */
  applied: number;
  slit: boolean;
  scale: number;
}

/** Where strikes may land: the cluster's centre, and the box strays fall in (page px). */
export interface Target {
  cx: number;
  cy: number;
  box: [number, number, number, number];
}

const tipHeight = (t: Tip, x: number, y: number) => {
  const dx = x - t.x;
  const dy = y - t.y;
  const ca = Math.cos(t.a);
  const sa = Math.sin(t.a);
  const u = dx * ca + dy * sa;
  const v = -dx * sa + dy * ca;
  // sharper toward the claw's point
  const a = u > 0 ? t.len * 0.55 : t.len;
  const d = Math.sqrt((u / a) ** 2 + (v / t.wid) ** 2);
  let h = d < 1 ? (1 - d) ** 2 : 0;
  h -= STRIKE.trough * Math.exp(-(((d - 1.2) / 0.45) ** 2));
  return h * t.depth;
};

export class Strikes {
  readonly punctures: Puncture[] = [];
  private live: Strike[] = [];
  private done: Strike[] = [];
  count = 0;

  constructor(private material: Material) {}

  /** A strike at (x, y), or a placed one by the target's rules. Returns where it hit. */
  strike(target: Target, at?: { x: number; y: number }): { x: number; y: number } {
    let x: number;
    let y: number;
    const stray = !at && Math.random() > STRIKE.cluster;
    if (at) ({ x, y } = at);
    else if (stray) {
      const [x0, y0, x1, y1] = target.box;
      // anywhere in the box but the cluster
      do {
        x = rand(x0, x1);
        y = rand(y0, y1);
      } while (Math.hypot(x - target.cx, y - target.cy) < STRIKE.spread * 2.5 && Math.random() < 0.95);
    } else {
      x = target.cx + gauss() * STRIKE.spread;
      y = target.cy + gauss() * STRIKE.spread * 0.8;
    }
    const grow = Math.min(STRIKE.maxGrowth, this.count * STRIKE.growth);
    this.count++;
    // claws mostly point up (a hand reaching up from below), swung either way
    const a = -Math.PI / 2 + gauss() * 0.5;
    const n = Math.random() < 0.5 ? STRIKE.claws[0] : STRIKE.claws[1];
    const gap = rand(...STRIKE.spacing);
    const curve = rand(...STRIKE.curve);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const tips: Tip[] = [];
    for (let i = 0; i < n; i++) {
      const s = i - (n - 1) / 2;
      const off = s * gap + rand(-3, 3);
      // the middle fingers reach further: the row sags back at its ends
      const back = -curve * (s / ((n - 1) / 2 || 1)) ** 2;
      const mid = 1 - Math.abs(s) / n;
      tips.push({
        x: x - sa * off + ca * back,
        y: y + ca * off + sa * back,
        a: a + s * 0.12 + rand(-0.08, 0.08),
        depth: rand(...STRIKE.depth) * (0.8 + 0.3 * mid) * (1 + grow),
        len: rand(...STRIKE.length) * (1 + grow * 0.5),
        wid: rand(...STRIKE.width),
      });
    }
    const st: Strike = { x, y, a, tips, t: 0, applied: 0, slit: Math.random() < 0.75 + grow, scale: stray ? 0.75 : 1 };
    for (const t of st.tips) t.depth *= st.scale;
    this.live.push(st);
    this.material.wave(x, y, STRIKE.wave * st.scale);
    this.material.shake(STRIKE.shake * st.scale);
    return { x, y };
  }

  private stampOf(st: Strike, k: number) {
    if (k === 0) return;
    const pad = 40;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const t of st.tips) {
      x0 = Math.min(x0, t.x - t.len - pad);
      y0 = Math.min(y0, t.y - t.len - pad);
      x1 = Math.max(x1, t.x + t.len + pad);
      y1 = Math.max(y1, t.y + t.len + pad);
    }
    const r = STRIKE.palmRadius;
    // the palm sits behind the tips (away from where the claws point)
    const px = st.x - Math.cos(st.a) * 30;
    const py = st.y - Math.sin(st.a) * 30;
    x0 = Math.min(x0, px - r * 2);
    y0 = Math.min(y0, py - r * 2);
    x1 = Math.max(x1, px + r * 2);
    y1 = Math.max(y1, py + r * 2);
    const sign = STRIKE.direction;
    const palm = STRIKE.palm * st.scale;
    this.material.stamp(x0, y0, x1, y1, (x, y) => {
      let h = palm * Math.exp(-((x - px) ** 2 + (y - py) ** 2) / (r * r));
      for (const t of st.tips) h += tipHeight(t, x, y);
      return h * sign;
    }, k);
  }

  /** The impact's depth over time: punched past its final depth, then settling. */
  private profile(t: number) {
    if (t < STRIKE.punch) return (t / STRIKE.punch) * (1 + STRIKE.overshoot);
    const s = clamp((t - STRIKE.punch) / STRIKE.settle, 0, 1);
    return 1 + STRIKE.overshoot * (1 - s) * (1 - s) * Math.cos(s * 9);
  }

  update(dt: number) {
    for (const st of this.live) {
      st.t += dt;
      const k = st.t >= STRIKE.punch + STRIKE.settle ? 1 : this.profile(st.t);
      this.stampOf(st, k - st.applied);
      st.applied = k;
      if (st.slit && st.t >= STRIKE.punch) {
        st.slit = false;
        for (const t of st.tips) {
          if (Math.random() > 0.85) continue;
          this.punctures.push({
            x: t.x + Math.cos(t.a) * 1.5,
            y: t.y + Math.sin(t.a) * 1.5,
            a: t.a,
            len: t.len * STRIKE.slitLength * rand(0.7, 1.2),
            w: STRIKE.slitWidth * rand(0.8, 1.2) * st.scale,
          });
        }
      }
    }
    const finished = this.live.filter((s) => s.applied === 1);
    this.done.push(...finished);
    this.live = this.live.filter((s) => s.applied !== 1);
  }

  get busy() {
    return this.live.length > 0;
  }

  /** The field was rebuilt (a resize): put every finished strike's dents back. */
  restamp() {
    for (const st of this.done) this.stampOf(st, 1);
    for (const st of this.live) this.stampOf(st, st.applied);
  }

  /** The slits: a pale lip catching the light above, the dark cut below. */
  draw(b: Batch, _v: View) {
    for (const p of this.punctures) {
      const ca = Math.cos(p.a);
      const sa = Math.sin(p.a);
      const lens = (dx: number, dy: number, w: number, c: readonly number[]) => {
        const L = p.len / 2;
        const pts = [
          p.x - ca * L + dx, p.y - sa * L + dy,
          p.x - ca * L * 0.3 - sa * w + dx, p.y - sa * L * 0.3 + ca * w + dy,
          p.x + ca * L * 0.4 - sa * w * 0.6 + dx, p.y + sa * L * 0.4 + ca * w * 0.6 + dy,
          p.x + ca * L + dx, p.y + sa * L + dy,
          p.x + ca * L * 0.4 + sa * w * 0.6 + dx, p.y + sa * L * 0.4 - ca * w * 0.6 + dy,
          p.x - ca * L * 0.3 + sa * w + dx, p.y - sa * L * 0.3 - ca * w + dy,
        ];
        b.poly(pts, [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5], c);
      };
      lens(-0.7, -0.8, p.w * 0.8, [1, 1, 1, 0.7]);
      lens(0.5, 0.6, p.w * 0.75, [0.55, 0.55, 0.56, 0.35]);
      lens(0, 0, p.w / 2, [0.04, 0.035, 0.04, 0.92]);
    }
  }
}
