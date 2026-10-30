// The opening, where plates have been knocked out: the black behind the wall, and round it the wall's broken
// thickness. The break narrows going in (a punch from behind shears out a cone), so you see the rim's inside faces
// from the front, shaded by the key light: lit at the bottom right, dark at the top left. Ink on the opening's
// edge and, thinner, where the rim meets the dark.
import { seeded, type View } from "./core.ts";
import type { Fracture } from "./cracks.ts";
import { MATERIAL } from "./material.ts";
import type { Scene, V3 } from "./scene.ts";

export const HOLE = {
  /** how far the rim comes in going through the wall, against the wall's thickness */
  slope: 0.5,
  /** how much that varies round the rim (a fraction) */
  vary: 0.35,
  /** and point to point (the broken inner edge is jagged too) */
  jag: 0.35,
  /** smoothing of the rim's direction (points either way) */
  smooth: 4,
  /** the rim's faces are this much darker than plate sides (they're inside a hole) */
  shade: 0.93,
};

interface Loop {
  top: V3[];
  bot: V3[];
  nrm: V3[];
}

export class Hole {
  private loops: Loop[] = [];
  private built = -1;
  private ext: [number, number, number] = [0, 0, 0];

  constructor(private f: Fracture) {}

  /** the opening's outline: each loop's points on the wall's face and where the rim meets the dark (page px; z 0 and
   *  -thickness); `version` changes when it does */
  outline(): { version: number; loops: { top: V3[]; bot: V3[] }[] } {
    this.build();
    return { version: this.built, loops: this.loops };
  }

  /** the opening's middle and size (page px: x, y, radius of a disc of the same area); radius 0 before it opens */
  extent(): [number, number, number] {
    this.build();
    return this.ext;
  }

  private build() {
    const removed = this.f.removed;
    if (this.built === removed.length) return;
    this.built = removed.length;
    this.loops = [];
    if (!removed.length) {
      this.ext = [this.f.cx, this.f.cy, 0];
      return;
    }
    let A = 0;
    let X = 0;
    let Y = 0;
    for (const s of removed) {
      A += s.area;
      X += s.cx * s.area;
      Y += s.cy * s.area;
    }
    this.ext = [X / A, Y / A, Math.sqrt(A / Math.PI)];

    // the outline: every plate's outline segment that isn't shared with another removed plate, chained
    const key = (x: number, y: number) => `${x.toFixed(3)},${y.toFixed(3)}`;
    const segs = new Map<string, [number, number, number, number]>();
    for (const s of removed) {
      const p = s.poly;
      const n = p.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = key(p[i * 2]!, p[i * 2 + 1]!);
        const b = key(p[j * 2]!, p[j * 2 + 1]!);
        if (segs.has(b + "|" + a)) segs.delete(b + "|" + a);
        else segs.set(a + "|" + b, [p[i * 2]!, p[i * 2 + 1]!, p[j * 2]!, p[j * 2 + 1]!]);
      }
    }
    const byStart = new Map<string, string[]>();
    for (const k of segs.keys()) {
      const a = k.split("|")[0]!;
      const l = byStart.get(a);
      if (l) l.push(k);
      else byStart.set(a, [k]);
    }
    const used = new Set<string>();
    const T = MATERIAL.thickness;
    for (const k0 of segs.keys()) {
      if (used.has(k0)) continue;
      const pts: number[] = [];
      let k: string | undefined = k0;
      while (k && !used.has(k)) {
        used.add(k);
        const s = segs.get(k)!;
        pts.push(s[0], s[1]);
        const end: string = k.split("|")[1]!;
        k = byStart.get(end)?.find((x) => !used.has(x));
      }
      const n = pts.length / 2;
      if (n < 3) continue;
      // inward (into the opening: left of the way round) normals, smoothed
      const seg: number[] = [];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const dx = pts[j * 2]! - pts[i * 2]!;
        const dy = pts[j * 2 + 1]! - pts[i * 2 + 1]!;
        seg.push(-dy, dx);
      }
      const r = seeded(Math.round(pts[0]! * 13 + pts[1]! * 7));
      const vary: number[] = [];
      for (let i = 0; i < n; i++) vary.push(r());
      const loop: Loop = { top: [], bot: [], nrm: [] };
      const W = HOLE.smooth;
      for (let i = 0; i < n; i++) {
        let nx = 0;
        let ny = 0;
        let v = 0;
        for (let k2 = -W; k2 < W; k2++) {
          const q = (((i + k2) % n) + n) % n;
          nx += seg[q * 2]!;
          ny += seg[q * 2 + 1]!;
          v += vary[q]!;
        }
        const l = Math.hypot(nx, ny) || 1;
        nx /= l;
        ny /= l;
        v /= 2 * W;
        const s = T * HOLE.slope * (1 + (v - 0.5) * 2 * HOLE.vary + (vary[i]! - 0.5) * HOLE.jag);
        loop.top.push([pts[i * 2]!, pts[i * 2 + 1]!, 0]);
        loop.bot.push([pts[i * 2]! + nx * s, pts[i * 2 + 1]! + ny * s, -T]);
        const nl = Math.hypot(T, s);
        loop.nrm.push([(nx * T) / nl, (ny * T) / nl, s / nl]);
      }
      this.loops.push(loop);
    }
  }

  draw(scene: Scene, _v: View) {
    this.build();
    const T = MATERIAL.thickness;
    const dark = MATERIAL.dark;
    // the dark: each knocked-out plate's footprint, at the back of the wall
    for (const s of this.f.removed) {
      const p = s.poly;
      for (let i = 0; i < s.tris.length; i += 3) {
        const a = s.tris[i]! * 2;
        const b = s.tris[i + 1]! * 2;
        const c = s.tris[i + 2]! * 2;
        scene.tri([p[a]!, p[a + 1]!, -T - 1], [p[b]!, p[b + 1]!, -T - 1], [p[c]!, p[c + 1]!, -T - 1], [0, 0, 1], dark);
      }
    }
    const C = MATERIAL.core.map((x) => x * HOLE.shade);
    const ink = MATERIAL.ink;
    for (const L of this.loops) {
      const n = L.top.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = L.nrm[i]!;
        const b = L.nrm[j]!;
        const nn = [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
        scene.tri(L.top[i]!, L.bot[i]!, L.top[j]!, nn, C);
        scene.tri(L.top[j]!, L.bot[i]!, L.bot[j]!, nn, C);
        scene.seg(L.top[i]!, L.top[j]!, MATERIAL.inkEdge, ink);
        scene.seg(L.bot[i]!, L.bot[j]!, MATERIAL.inkBack, ink, 0.8);
      }
    }
  }
}
