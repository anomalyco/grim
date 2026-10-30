// A punch site. Each punch is one hard, discrete knock: one or two new cracks run out along the fracture (cracks.ts),
// one plate that's free tips up a few degrees more about its hinge (plates.ts), and crumbs spit out (debris.ts).
// Nothing bends or settles: the plates only rotate, rigidly, snapping to their new angle. The site also draws its
// plates, its cracks, and the dark behind anything tipped up; and it picks the plates for the breakthrough and the
// widening.
import { rand } from "./core.ts";
import { Fracture, type Edge } from "./cracks.ts";
import type { Debris } from "./debris.ts";
import { MATERIAL } from "./material.ts";
import { drawSlab, drawWall, Plate, PLATE } from "./plates.ts";
import type { Scene, V3 } from "./scene.ts";

export const PUNCH = {
  /** new cracks running out per punch: the first punch, and the chance of a second after that (a crack: one to
   *  `reach` fracture edges in a run). Besides, while no plate is free to tip, one more crack frees one. */
  cracksFirst: 2,
  second: 0.3,
  reach: 3,
  /** a crack carries on to the next edge with this chance */
  carry: 0.55,
  /** randomness in where cracks go (against nearest the impact first) */
  wander: 0.45,
  /** the first punch only cracks; after that, a plate lifts if one's free. Chance of tipping one that's already up
   *  (against starting another) */
  again: 0.55,
};

export interface SiteShape {
  /** size of the fracture */
  scale: number;
  /** how far plates tip */
  tilt: number;
}

export class Site {
  readonly fracture: Fracture;
  readonly plates: Plate[];
  n = 0;

  constructor(
    readonly cx: number,
    readonly cy: number,
    low: boolean,
    shape: SiteShape,
    private debris: Debris,
  ) {
    this.fracture = new Fracture(cx, cy, shape.scale, low);
    this.plates = this.fracture.shapes.map((s) => new Plate(s, this.fracture, shape.tilt));
  }

  get radius() {
    return this.fracture.radius;
  }

  /** One knock. */
  punch() {
    this.n++;
    const f = this.fracture;
    const fresh: Edge[] = [];
    if (this.n > 1) fresh.push(...this.chaseOne());
    const k = this.n === 1 ? PUNCH.cracksFirst : Math.random() < PUNCH.second ? 2 : 1;
    for (let i = 0; i < k; i++) fresh.push(...this.crackOne());
    let lifted: Plate | null = null;
    if (this.n > 1) lifted = this.liftOne();
    // crumbs: from the lifted plate's free edge, or from the new cracks
    const pts: [number, number][] = [];
    let dx = 0;
    let dy = 0;
    if (lifted) {
      const x = lifted.xf;
      const [ax, ay] = lifted.away;
      dx = ax;
      dy = ay;
      const p = lifted.shape.poly;
      for (const s of lifted.shape.sides) {
        if (s.edge === lifted.hinge) continue;
        const m = s.edge.pts.length / 2 - 1;
        for (let q = 0; q < m; q += 2) {
          const i = (s.start + q) % (p.length / 2);
          const [wx, wy] = [p[i * 2]!, p[i * 2 + 1]!];
          const r = x.r;
          pts.push([r[0]! * wx + r[1]! * wy + x.t[0], r[3]! * wx + r[4]! * wy + x.t[1]]);
        }
      }
    }
    for (const e of fresh) for (let q = 0; q < e.pts.length; q += 4) pts.push([e.pts[q]!, e.pts[q + 1]!]);
    this.debris.crumbs(pts, dx, dy);
    return f;
  }

  /** While no plate is free to tip, a crack toward freeing the plate nearest to free (fewest sides still whole,
   *  nearest the impact). */
  private chaseOne(): Edge[] {
    const f = this.fracture;
    const R = f.radius;
    if (this.plates.some((p) => p.free && !p.lifted)) return [];
    let goal: Edge | null = null;
    let gs = Infinity;
    for (const p of this.plates) {
      if (p.removed || p.lifted || !p.hinge) continue;
      const missing = p.shape.sides.filter((s) => s.edge !== p.hinge && !s.edge.cracked);
      if (missing.some((s) => s.edge.outer)) continue;
      const next = missing.find((s) => f.reached.has(s.edge.a) || f.reached.has(s.edge.b));
      if (!next) continue;
      const score = missing.length + (p.shape.r / R) * 2 + Math.random() * 0.8;
      if (score < gs) {
        gs = score;
        goal = next.edge;
      }
    }
    if (!goal) return [];
    f.crack(goal, this.n);
    return [goal];
  }

  /** One crack running out: from where the cracks have reached, nearest the impact first, and maybe on to the next
   *  edge, outward. */
  private crackOne(): Edge[] {
    const f = this.fracture;
    const R = f.radius;
    const touches = (e: Edge) => f.reached.has(e.a) || f.reached.has(e.b);
    const cands = f.edges.filter((e) => !e.cracked && !e.outer && touches(e));
    if (!cands.length) return [];
    const mid = (e: Edge) => {
      const m = e.pts.length >> 2 << 1;
      return Math.hypot(e.pts[m]! - f.cx, e.pts[m + 1]! - f.cy) / R;
    };
    let best = cands[0]!;
    let bs = Infinity;
    for (const e of cands) {
      const s = mid(e) + Math.random() * PUNCH.wander;
      if (s < bs) {
        bs = s;
        best = e;
      }
    }
    const out = [best];
    f.crack(best, this.n);
    // on outward from its far end
    let tip = best.fromB ? best.a : best.b;
    for (let i = 1; i < PUNCH.reach && Math.random() < PUNCH.carry; i++) {
      const [tx, ty] = f.cornerXY(tip);
      const tr = Math.hypot(tx - f.cx, ty - f.cy);
      const next = f.edges.filter((e) => {
        if (e.cracked || e.outer || (e.a !== tip && e.b !== tip)) return false;
        const [ox, oy] = f.cornerXY(e.a === tip ? e.b : e.a);
        return Math.hypot(ox - f.cx, oy - f.cy) > tr - 4;
      });
      if (!next.length) break;
      const e = next[Math.floor(Math.random() * next.length)]!;
      f.crack(e, this.n);
      out.push(e);
      tip = e.a === tip ? e.b : e.a;
    }
    return out;
  }

  /** One plate tips up some more: one already up (now and then), or a newly free one, nearest the impact first. */
  private liftOne(): Plate | null {
    const free = this.plates.filter((p) => p.free && p.target < p.max - 1e-3);
    if (!free.length) return null;
    const up = free.filter((p) => p.lifted);
    const fresh = free.filter((p) => !p.lifted);
    const R = this.fracture.radius;
    // a fresh plate whose free sides border flat plates shows its broken thickness: those first
    const exposed = (q: Plate) => q.shape.sides.filter((x) => {
      if (x.edge === q.hinge) return false;
      const o = x.edge.left === q.shape.id ? x.edge.right : x.edge.left;
      return o < 0 || !this.plates[o]!.lifted;
    }).length / q.shape.sides.length;
    let p: Plate;
    if (up.length && (!fresh.length || Math.random() < PUNCH.again)) p = up[Math.floor(Math.random() * up.length)]!;
    else {
      const score = (q: Plate) => q.shape.r / R - exposed(q) * 0.8 + Math.random() * 0.3;
      p = fresh.reduce((a, b) => (score(b) < score(a) ? b : a));
    }
    p.lift(p.lifted ? rand(...PLATE.step) : rand(...PLATE.first));
    return p;
  }

  /** The plates to knock out at the breakthrough: everything tipped up, and the plates round the impact. */
  breakthrough(): Plate[] {
    const R = this.fracture.radius;
    return this.plates
      .filter((p) => !p.removed && (p.lifted || p.shape.r < R * 0.3))
      .sort((a, b) => a.shape.r - b.shape.r);
  }

  /** `k` more plates next to the opening (not past `reach` of the radius), and the plates that are then free on
   *  the opening's side tip up a little (the rim is wrecked). */
  widen(k: number, reach: number): Plate[] {
    const R = this.fracture.radius;
    const gone = new Set(this.fracture.removed.map((s) => s.id));
    const nextTo = (p: Plate) => p.shape.sides.some((s) => {
      const o = s.edge.left === p.shape.id ? s.edge.right : s.edge.left;
      return o >= 0 && gone.has(o);
    });
    const cands = this.plates.filter((p) => !p.removed && p.shape.r < R * reach && nextTo(p));
    cands.sort((a, b) => a.shape.r + Math.random() * R * 0.35 - (b.shape.r + Math.random() * R * 0.35));
    return cands.slice(0, k);
  }

  /** Knock a plate out: it leaves the wall (as debris) from where it is. */
  knockOut(p: Plate, hx: number, hy: number) {
    if (p.removed) return;
    const x = p.xf;
    const ox = p.shape.cx - hx;
    const oy = p.shape.cy - hy;
    const ol = Math.hypot(ox, oy) || 1;
    const away: [number, number] = p.lifted ? p.away : [ox / ol, oy / ol];
    p.removed = true;
    for (const s of p.shape.sides) this.fracture.crack(s.edge, this.n, true);
    this.fracture.removed.push(p.shape);
    this.debris.knock(p.slab, x, p.shape.cx, p.shape.cy, hx, hy, away);
  }

  /** Plates next to the opening that are free now tip up a little (after a widening). */
  wreckRim(n: number, going: Plate[]) {
    const gone = new Set([...this.fracture.removed.map((s) => s.id), ...going.map((p) => p.shape.id)]);
    const rim = this.plates.filter((p) => !p.removed && !going.includes(p) && p.hinge && p.shape.sides.some((s) => {
      const o = s.edge.left === p.shape.id ? s.edge.right : s.edge.left;
      return o >= 0 && gone.has(o) && s.edge !== p.hinge;
    }));
    for (let i = 0; i < n && rim.length; i++) {
      const p = rim.splice(Math.floor(Math.random() * rim.length), 1)[0]!;
      for (const s of p.shape.sides) if (s.edge !== p.hinge && !s.edge.outer) this.fracture.crack(s.edge, this.n);
      if (p.free) p.lift(rand(...PLATE.first));
    }
  }

  get busy() {
    return this.plates.some((p) => p.busy) || this.fracture.edges.some((e) => e.cracked && e.run < 1);
  }

  get lifting() {
    return this.plates.some((p) => p.lifted && !p.removed);
  }

  update(dt: number) {
    this.fracture.update(dt);
    for (const p of this.plates) p.update(dt);
  }

  draw(scene: Scene) {
    const T = MATERIAL.thickness;
    const P = MATERIAL.paper;
    const dark = MATERIAL.dark;
    for (const p of this.plates) {
      if (p.removed) continue;
      const s = p.shape;
      if (!p.lifted) {
        // flat: just its face (it hides what's behind it)
        for (let i = 0; i < s.tris.length; i += 3) {
          const a = s.tris[i]! * 2;
          const b = s.tris[i + 1]! * 2;
          const c = s.tris[i + 2]! * 2;
          scene.tri([s.poly[a]!, s.poly[a + 1]!, 0], [s.poly[b]!, s.poly[b + 1]!, 0], [s.poly[c]!, s.poly[c + 1]!, 0], [0, 0, 1], P);
        }
        // and its broken sides where a neighbour's tipped up (seen down the gap)
        for (const side of s.sides) {
          const o = side.edge.left === s.id ? side.edge.right : side.edge.left;
          if (o >= 0 && this.plates[o]!.lifted && !this.plates[o]!.removed) drawWall(scene, p.slab, side.start, side.edge.pts.length / 2 - 1);
        }
        continue;
      }
      // tipped up: the dark behind where it was, then the slab
      for (let i = 0; i < s.tris.length; i += 3) {
        const a = s.tris[i]! * 2;
        const b = s.tris[i + 1]! * 2;
        const c = s.tris[i + 2]! * 2;
        scene.tri([s.poly[a]!, s.poly[a + 1]!, -T - 1], [s.poly[b]!, s.poly[b + 1]!, -T - 1], [s.poly[c]!, s.poly[c + 1]!, -T - 1], [0, 0, 1], dark);
      }
      drawSlab(scene, p.slab, p.xf, { solid: true, ink: MATERIAL.inkEdge, inkBack: MATERIAL.inkBack, shadow: 1 });
    }
    // cracks in the face of the wall: on flat plates (a tipped plate inks its own outline; the opening inks its rim)
    const flat = (id: number) => id < 0 || (!this.plates[id]!.removed && !this.plates[id]!.lifted);
    const gone = (id: number) => id >= 0 && this.plates[id]!.removed;
    for (const e of this.fracture.edges) {
      if (!e.cracked || gone(e.left) || gone(e.right)) continue;
      if (!flat(e.left) && !flat(e.right)) continue;
      this.crackLine(scene, e);
    }
  }

  /** A crack in the face: ink with a slight dark gap either side, run out as far as it's got. */
  private crackLine(scene: Scene, e: Edge) {
    const m = e.pts.length / 2;
    const segs = m - 1;
    const upto = e.run * segs;
    const ink = MATERIAL.ink;
    for (let i = 0; i < segs && i < upto; i++) {
      const q = e.fromB ? segs - 1 - i : i;
      const f = Math.min(1, upto - i);
      const a: V3 = [e.pts[q * 2]!, e.pts[q * 2 + 1]!, 0];
      let b: V3 = [e.pts[q * 2 + 2]!, e.pts[q * 2 + 3]!, 0];
      if (e.fromB) b = [e.pts[q * 2]!, e.pts[q * 2 + 1]!, 0];
      const s0: V3 = e.fromB ? [e.pts[q * 2 + 2]!, e.pts[q * 2 + 3]!, 0] : a;
      const s1: V3 = [s0[0]! + (b[0]! - s0[0]!) * f, s0[1]! + (b[1]! - s0[1]!) * f, 0];
      scene.seg(s0, s1, MATERIAL.gap, ink, MATERIAL.gapAlpha);
      scene.seg(s0, s1, MATERIAL.inkCrack, ink);
    }
  }
}
