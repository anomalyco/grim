// Punches: something behind the wall punches it at a site. Each punch bulges the drywall out toward you (a soft, wide
// swell with a firmer middle, stamped into material.ts's height field, a little deeper every time), knocks a flex wave
// through the wall and shakes the page. With repeated punches the board gives: cracks radiate from the middle and run
// further out each time (cracks.ts), concentric fractures join them, the plates between start to lift and jolt with
// every punch (plates.ts), and dust and crumbs puff out of the cracks (dust.ts). How far each stage gets per punch is
// here; when the punches come is timeline.ts.
import { clamp, gauss, rand } from "./core.ts";
import { Fracture } from "./cracks.ts";
import type { Dust } from "./dust.ts";
import type { Material } from "./material.ts";
import { PLATE, Plates } from "./plates.ts";

export const PUNCH = {
  /** each punch adds this much bulge (px toward you), up to `bulgeMax`; its width (px, one sd) and its firmer middle */
  bulge: [2.4, 4] as const,
  bulgeMax: 30,
  width: 125,
  widthLow: 80,
  core: 0.35,
  /** a punch lands within this of the site's middle (px) */
  aim: 10,
  /** the knock: pushed past its share by `overshoot` in `punch` s, settling back over `settle` s */
  overshoot: 1.1,
  punch: 0.06,
  settle: 0.5,
  /** flex wave (px) and page shake (0..1) per punch */
  wave: 2.6,
  shake: 0.5,
  /** cracks start on this punch, running one ring further out each punch after; concentric cracks from `ringsFrom`
   *  (each with chance `ringChance` a punch) */
  cracksFrom: 3,
  ringsFrom: 5,
  ringChance: 0.55,
  /** plates free to lift start lifting on this punch, by this much more each punch (outer rings less) */
  liftFrom: 6,
  liftStep: 0.17,
  /** dust from this punch: puffs and crumbs, more with every punch */
  dustFrom: 3,
  puffs: [1, 3] as const,
  crumbs: [1, 4] as const,
};

/** A site's own character: how big, how far it tilts, how far its plates may lift, how deep it bulges. */
export interface SiteShape {
  scale: number;
  tilt: number;
  liftMax: number;
  bulge: number;
}

interface Knock {
  x: number;
  y: number;
  amp: number;
  t: number;
  applied: number;
}

export class Site {
  readonly fracture: Fracture;
  readonly plates: Plates;
  /** punches so far */
  n = 0;
  private bulge = 0;
  private live: Knock[] = [];
  private done: Knock[] = [];
  private width: number;

  constructor(
    private material: Material,
    private dust: Dust,
    readonly cx: number,
    readonly cy: number,
    private low: boolean,
    readonly shape: SiteShape,
  ) {
    this.fracture = new Fracture(cx, cy, low, shape.scale);
    this.plates = new Plates(this.fracture, material, shape.tilt);
    this.width = (low ? PUNCH.widthLow : PUNCH.width) * shape.scale;
  }

  /** A punch from behind. floor: page y crumbs fall to (the window's bottom). */
  punch(floor: number) {
    this.n++;
    const n = this.n;
    const add = Math.min(rand(...PUNCH.bulge) * this.shape.bulge, PUNCH.bulgeMax * this.shape.bulge - this.bulge);
    this.bulge += Math.max(0, add);
    const x = this.cx + gauss() * PUNCH.aim;
    const y = this.cy + gauss() * PUNCH.aim;
    this.live.push({ x, y, amp: Math.max(0.6, add), t: 0, applied: 0 });
    // the knock runs through the wall (out toward you: a negative bend)
    this.material.wave(x, y, -PUNCH.wave * this.shape.scale * (0.8 + 0.04 * n));
    this.material.shake(PUNCH.shake * (0.7 + 0.03 * n));
    const f = this.fracture;
    if (n >= PUNCH.cracksFrom) {
      const radial = n - PUNCH.cracksFrom + 1;
      const ring = n >= PUNCH.ringsFrom ? n - PUNCH.ringsFrom + 1 : 0;
      f.advance(radial, ring, PUNCH.ringChance);
    }
    if (n >= PUNCH.liftFrom) {
      for (const c of f.cells) {
        if (!f.canLift(c)) continue;
        const step = PUNCH.liftStep * (1 - c.ring * 0.13) * (0.7 + 0.6 * c.seed);
        const most = this.shape.liftMax * (PLATE.ringLift[Math.min(c.ring, PLATE.ringLift.length - 1)] ?? 0.1);
        c.liftTarget = Math.min(most, c.liftTarget + step);
      }
    }
    this.plates.jolt(0.6 + 0.04 * n);
    if (n >= PUNCH.dustFrom) {
      const k = clamp((n - PUNCH.dustFrom + 1) / 6, 0.3, 1.6);
      // out of the cracks: from cracked corners near the middle
      const near = f.verts.filter((v) => v.cracked && Math.hypot(v.x - this.cx, v.y - this.cy) < f.radius * 0.6);
      const puffs = Math.round(rand(...PUNCH.puffs) * k) + 1;
      for (let i = 0; i < puffs; i++) {
        const v = near[Math.floor(Math.random() * near.length)] ?? { x: this.cx, y: this.cy };
        this.dust.puff(v.x, v.y, 1, k, 6);
      }
      this.dust.spit(this.cx, this.cy, Math.round(rand(...PUNCH.crumbs) * k), floor, f.radius * 0.15, k * 0.8);
    }
  }

  private stamp(kn: Knock, k: number) {
    if (k === 0) return;
    const w = this.width;
    const core = w * PUNCH.core;
    const { x, y, amp } = kn;
    this.material.stamp(x - w * 3, y - w * 3, x + w * 3, y + w * 3, (px, py) => {
      const r2 = (px - x) ** 2 + (py - y) ** 2;
      return amp * (0.7 * Math.exp(-r2 / (w * w)) + 0.3 * Math.exp(-r2 / (core * core)));
    }, k);
  }

  private profile(t: number) {
    if (t < PUNCH.punch) return (t / PUNCH.punch) * (1 + PUNCH.overshoot);
    const s = clamp((t - PUNCH.punch) / PUNCH.settle, 0, 1);
    return 1 + PUNCH.overshoot * (1 - s) * (1 - s) * Math.cos(s * 7);
  }

  update(dt: number) {
    for (const kn of this.live) {
      kn.t += dt;
      const k = kn.t >= PUNCH.punch + PUNCH.settle ? 1 : this.profile(kn.t);
      this.stamp(kn, k - kn.applied);
      kn.applied = k;
    }
    this.done.push(...this.live.filter((k) => k.applied === 1));
    this.live = this.live.filter((k) => k.applied !== 1);
    this.fracture.update(dt);
    this.plates.update(dt);
  }

  get busy() {
    return this.live.length > 0 || this.fracture.busy || this.plates.busy;
  }

  /** The field was rebuilt (a resize): put the bulge back. */
  restamp() {
    for (const k of this.done) this.stamp(k, 1);
    for (const k of this.live) this.stamp(k, k.applied);
  }

  /** Plates that break out on the breakthrough: the centre wedges, and any of the next ring that are well up. */
  breakthrough() {
    const f = this.fracture;
    return f.cells.filter((c) => !c.removed && (c.ring === 0 || (c.ring === 1 && (c.lift > 0.5 || Math.random() < 0.4))));
  }

  /** The next plates to go as the hole widens. */
  widen(n: number) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const c = this.fracture.nextCell();
      if (!c) break;
      c.removed = true;
      out.push(c);
    }
    for (const c of out) c.removed = false;
    return out;
  }
}
