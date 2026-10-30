// What moist-burrito draws, now and then (AGENT_DRAWS in home-lines.ts): two careful, creepy pencil drawings. Each is
// its marks, in the order a person would draw them, as polylines in a box 1 unit tall and `aspect` wide, centred on
// (0, 0), y down: contours (drawn slowly), hatching (dark scribbled fields and shadows, scribbled fast) and light lines.
// `make` gets a random source, so each comes out a little different (tilt, reach, grin width). The bot draws them with
// its own pencil, stroke by stroke, in about `secs` (handwriting.ts drawPicture; placed like a line: home.ts).
import type { Mark } from "./handwriting.ts";

export type Pt = [number, number];

export interface Drawing {
  id: string;
  /** width over height */
  aspect: number;
  /** how tall it's drawn, in px on a desktop (smaller on a phone) */
  height: [number, number];
  /** how long the pencil takes over it, in seconds (the scribbling speeds up to fit; with the hop over and the tip going
   *  down it's a second or so more on the page) */
  secs: [number, number];
  make(rand: () => number): Mark[];
}

const between = (r: () => number, lo: number, hi: number) => lo + r() * (hi - lo);

/** an elliptical arc from angle a0 to a1 (radians; 0 is right, y down), rotated by `rot` */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n = 24, rot = 0): Pt[] {
  const out: Pt[] = [];
  const [c, s] = [Math.cos(rot), Math.sin(rot)];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    const [x, y] = [Math.cos(a) * rx, Math.sin(a) * ry];
    out.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return out;
}

/** a quadratic curve from a to b, pulled towards c */
function curve(a: Pt, c: Pt, b: Pt, n = 20): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
  }
  return out;
}

/** a ragged radius: 1, give or take `amt`, wandering round the angle */
function ragged(r: () => number, amt: number): (a: number) => number {
  const [p1, p2, p3] = [r() * 6, r() * 6, r() * 6];
  return (a) => 1 + amt * (0.5 * Math.sin(3 * a + p1) + 0.3 * Math.sin(7 * a + p2) + 0.2 * Math.sin(13 * a + p3));
}

/** inside an ellipse round (cx, cy), its edge `edge(angle)` times its radii */
function inEllipse(x: number, y: number, cx: number, cy: number, rx: number, ry: number, edge: (a: number) => number = () => 1): boolean {
  const [dx, dy] = [(x - cx) / rx, (y - cy) / ry];
  return Math.hypot(dx, dy) < edge(Math.atan2(dy, dx));
}

/**
 * Scribbled hatching over the region `inside`, within `box` [x0, y0, x1, y1]: parallel lines `gap` apart at `angle`,
 * each run inside the region becoming a stroke's leg, chained back and forth into zigzags (as a hand scribbles a dark
 * patch without lifting), ends ragged by `rough` (in gaps).
 */
function hatch(r: () => number, inside: (x: number, y: number) => boolean, box: [number, number, number, number], angle: number, gap: number, rough = 0.6): Mark[] {
  const [dx, dy] = [Math.cos(angle), Math.sin(angle)];
  const [nx, ny] = [-dy, dx];
  const corners: Pt[] = [[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]]];
  const along = corners.map(([x, y]) => x * dx + y * dy);
  const across = corners.map(([x, y]) => x * nx + y * ny);
  const [d0, d1] = [Math.min(...along), Math.max(...along)];
  const [k0, k1] = [Math.min(...across), Math.max(...across)];
  const at = (k: number, d: number): Pt => [nx * k + dx * d, ny * k + dy * d];
  const step = gap * 0.35;
  type Chain = { pts: Pt[]; a: number; b: number; atB: boolean; line: number };
  let open: Chain[] = [];
  const done: Chain[] = [];
  let line = 0;
  for (let k = k0 + gap / 2; k < k1; k += gap * between(r, 0.8, 1.2), line++) {
    // the runs of this line inside the region
    const runs: [number, number][] = [];
    let start: number | null = null;
    for (let d = d0; d <= d1 + step; d += step) {
      const [x, y] = at(k, d);
      const isIn = d <= d1 && inside(x, y);
      if (isIn && start === null) start = d;
      if (!isIn && start !== null) {
        if (d - step - start > gap * 0.5) runs.push([start, d - step]);
        start = null;
      }
    }
    const next: Chain[] = [];
    for (let [a, b] of runs) {
      a += between(r, -rough, rough * 0.5) * gap;
      b += between(r, -rough * 0.5, rough) * gap;
      // carry on a chain from the line before that overlaps this run, else start one
      const i = open.findIndex((c) => c.line === line - 1 && c.a < b && c.b > a);
      const c = i >= 0 ? open.splice(i, 1)[0]! : { pts: [], a, b, atB: r() < 0.5, line };
      const [from, to] = c.atB ? [b, a] : [a, b];
      c.pts.push(at(k, from), at(k, to));
      Object.assign(c, { a, b, atB: !c.atB, line });
      next.push(c);
    }
    done.push(...open);
    open = next;
  }
  done.push(...open);
  // (then one scribble on into the next when they nearly meet, as a hand would without lifting; specks dropped)
  const left = done.map((c) => c.pts).filter((p) => p.length > 2 || Math.hypot(p[1]![0] - p[0]![0], p[1]![1] - p[0]![1]) > gap * 3);
  const out: Pt[][] = [];
  while (left.length) {
    let cur = left.shift()!;
    for (;;) {
      const end = cur[cur.length - 1]!;
      let best = -1;
      let flip = false;
      let bestD = gap * 4;
      left.forEach((p, i) => {
        const ds = Math.hypot(p[0]![0] - end[0], p[0]![1] - end[1]);
        const de = Math.hypot(p[p.length - 1]![0] - end[0], p[p.length - 1]![1] - end[1]);
        if (ds < bestD) [best, flip, bestD] = [i, false, ds];
        if (de < bestD) [best, flip, bestD] = [i, true, de];
      });
      if (best < 0) break;
      const next = left.splice(best, 1)[0]!;
      cur = cur.concat(flip ? next.reverse() : next);
    }
    out.push(cur);
  }
  return out.map((pts) => ({ pts, kind: "hatch" as const }));
}

/** a stroke drawn over a second time, a hair off (a pencil going back over a line it wants darker) */
function twice(pts: Pt[], off: number): Pt[] {
  const back = pts.slice().reverse().map(([x, y], i): Pt => [x + Math.sin(i * 0.7) * off, y + Math.cos(i * 0.5) * off]);
  return [...pts, ...back.slice(1)];
}

export const DRAWINGS: Drawing[] = [
  {
    // The Tall One: far off, on the horizon, very tall and thin and perfectly still. A dark scribbled body, arms that
    // hang past its knees ending in long thin fingers, feet lost in a smudge of shadow, and a blank, pale oval of a
    // head on a long neck, tilted a little. No face.
    id: "tall-one",
    aspect: 0.8,
    height: [150, 220],
    secs: [6.5, 8],
    make(r) {
      const marks: Mark[] = [];
      const ground = 0.44;
      // (its last mark, the head, is drawn slowest: see home.ts)
      // the horizon: faint, broken, and empty all the way along
      const gapAt = between(r, -0.1, 0.1);
      marks.push({ pts: [[-0.4, ground + between(r, -0.004, 0.004)], [gapAt - 0.07, ground]], kind: "light" });
      marks.push({ pts: [[gapAt + 0.06, ground], [0.4, ground + between(r, -0.004, 0.004)]], kind: "light" });
      const lean = between(r, -0.01, 0.01);
      const sh = -0.3; // shoulders
      const hip = -0.04;
      const xAt = (y: number) => lean * ((ground - y) / (ground - sh)); // its spine, leaning a hair
      // the torso: narrow, a little hunched at the shoulders, pinched at the waist
      const halfW = (y: number) => (y < sh + 0.025 ? 0.03 + ((y - sh) / 0.025) * 0.008 : 0.038 - ((y - sh - 0.025) / (hip - sh - 0.025)) * 0.016);
      for (const side of [-1, 1]) {
        const pts: Pt[] = [];
        for (let y = sh; y <= hip + 0.001; y += 0.02) pts.push([xAt(y) + side * halfW(y), y]);
        marks.push({ pts, kind: "fine" });
      }
      const inTorso = (x: number, y: number) => y >= sh && y <= hip + 0.01 && Math.abs(x - xAt(y)) < halfW(y);
      marks.push(...hatch(r, inTorso, [-0.06, sh - 0.01, 0.06, hip + 0.02], between(r, 1.3, 1.45), 0.006, 0.3));
      // the legs: long and thin and dead straight, gone over twice, thinning out into nothing at the bottom
      for (const side of [-1, 1]) {
        const top: Pt = [xAt(hip) + side * 0.013, hip];
        const foot: Pt = [xAt(ground) + side * between(r, 0.014, 0.02), ground - between(r, 0.0, 0.02)];
        marks.push({ pts: twice([top, [(top[0] + foot[0]) / 2 + side * 0.002, (top[1] + foot[1]) / 2], foot], 0.004), kind: "fine" });
      }
      // the arms: from the shoulders, bowing out a little, hanging down well past the knees (about y 0.2)
      const hands: Pt[] = [];
      for (const side of [-1, 1]) {
        const s: Pt = [xAt(sh) + side * 0.034, sh + 0.008];
        const hand: Pt = [xAt(0.3) + side * between(r, 0.066, 0.08), between(r, 0.27, 0.31)];
        const elbow: Pt = [side * between(r, 0.08, 0.095) + lean, between(r, -0.06, -0.01)];
        marks.push({ pts: twice(curve(s, elbow, hand, 26), 0.002), kind: "fine" });
        hands.push(hand);
      }
      // long thin fingers, splayed slightly, in one stroke a hand: down a finger, back up, down the next
      for (const [i, hand] of hands.entries()) {
        const side = i ? 1 : -1;
        const pts: Pt[] = [hand];
        const n = 4 + (r() < 0.4 ? 1 : 0);
        for (let f = 0; f < n; f++) {
          const a = Math.PI / 2 + side * (-0.2 + (0.55 * f) / (n - 1)) + between(r, -0.05, 0.05);
          const len = between(r, 0.09, 0.12) * (f === 0 || f === n - 1 ? 0.75 : 1);
          const bend = side * between(r, 0.05, 0.15);
          const knuckle: Pt = [hand[0] + Math.cos(a - bend) * len * 0.5, hand[1] + Math.sin(a - bend) * len * 0.5];
          const tip: Pt = [hand[0] + Math.cos(a) * len, hand[1] + Math.sin(a) * len];
          pts.push(knuckle, tip, knuckle, hand);
        }
        marks.push({ pts, kind: "fine" });
      }
      // the shadow its feet are lost in: a long low smudge of scribble, darker in the middle
      const shRx = between(r, 0.16, 0.22);
      const shEdge = ragged(r, 0.3);
      const cx = xAt(ground) + between(r, -0.02, 0.04);
      marks.push(...hatch(r, (x, y) => inEllipse(x, y, cx, ground - 0.004, shRx, 0.024, shEdge), [-0.3, ground - 0.04, 0.3, ground + 0.04], between(r, -0.1, 0.1), 0.0065, 0.9));
      marks.push(...hatch(r, (x, y) => inEllipse(x, y, xAt(ground), ground - 0.01, 0.05, 0.022), [-0.1, ground - 0.04, 0.1, ground + 0.02], 1.2, 0.005, 0.5));
      // a long thin neck, and last the head: a blank oval, pale, tilted
      const tilt = (r() < 0.5 ? -1 : 1) * between(r, 0.18, 0.35);
      const neck = 0.055;
      const hx = xAt(sh) + Math.sin(tilt) * 0.035;
      const hy = sh - neck - 0.045;
      marks.push({ pts: [[xAt(sh) - 0.006, sh + 0.004], [hx - 0.005 + Math.sin(tilt) * 0.01, hy + 0.042]], kind: "fine" });
      marks.push({ pts: [[xAt(sh) + 0.006, sh + 0.004], [hx + 0.005 + Math.sin(tilt) * 0.01, hy + 0.042]], kind: "fine" });
      marks.push({ pts: arc(hx, hy, 0.032, 0.048, -Math.PI / 2, Math.PI * 1.58, 30, tilt) });
      return marks;
    },
  },
  {
    // The Smile: a face looking out of pure darkness. The dark is scribbled in first, round a long pale face it leaves
    // (creeping in at its edges); then two hollow eye sockets, black, each with a pinpoint of white; last, slowly, a thin
    // grin far too wide, crowded with small sharp teeth. Nothing else.
    id: "smile",
    aspect: 1.1,
    height: [150, 205],
    secs: [6, 7.5],
    make(r) {
      const marks: Mark[] = [];
      const [fx, fy] = [between(r, -0.03, 0.03), between(r, -0.02, 0.02)];
      const [frx, fry] = [between(r, 0.25, 0.28), between(r, 0.37, 0.4)];
      const faceEdge = ragged(r, 0.1);
      const outerEdge = ragged(r, 0.07);
      const inFace = (x: number, y: number, k = 1) => inEllipse(x, y, fx, fy, frx * k, fry * k, faceEdge);
      // (the dark fills the box, a rough rectangle with ragged, scribbled-off edges)
      const inDark = (x: number, y: number) => {
        const a = Math.atan2(y, x);
        return Math.abs(x) < 0.53 * (0.94 + 0.06 * outerEdge(a)) && Math.abs(y) < 0.48 * (0.94 + 0.06 * outerEdge(a + 1));
      };
      const box: [number, number, number, number] = [-0.55, -0.5, 0.55, 0.5];
      // the darkness: scribbled solid up to the face, gone over again a little away from it (blackest out in the
      // dark), and creeping in round the face's edges, lighter
      marks.push(...hatch(r, (x, y) => inDark(x, y) && !inFace(x, y), box, between(r, 0.65, 0.85), 0.023, 0.9));
      marks.push(...hatch(r, (x, y) => inDark(x, y) && !inFace(x, y, 1.6), box, between(r, -0.75, -0.55), 0.05, 0.9));
      marks.push(...hatch(r, (x, y) => inFace(x, y) && !inFace(x, y, 0.85), [fx - frx, fy - fry, fx + frx, fy + fry], between(r, 0.65, 0.85), 0.026, 0.6));
      // the sockets: big, hollow and black, uneven, slanting down to the middle, each with a white pinpoint left in it
      const eyeY = fy - fry * between(r, 0.22, 0.3);
      const apart = frx * between(r, 0.42, 0.5);
      for (const side of [-1, 1]) {
        const ex = fx + side * apart;
        const ey = eyeY + (side > 0 ? between(r, -0.012, 0.012) : 0);
        const [rx, ry] = [between(r, 0.068, 0.078), between(r, 0.05, 0.06)];
        const rot = side * between(r, 0.2, 0.35);
        const pin: Pt = [ex - side * rx * 0.2, ey - ry * 0.15];
        const inOval = (x: number, y: number, k: number) => {
          const [ux, uy] = [x - ex, y - ey];
          const [c, s] = [Math.cos(-rot), Math.sin(-rot)];
          return Math.hypot((ux * c - uy * s) / (rx * k), (ux * s + uy * c) / (ry * k)) < 1;
        };
        const inSocket = (x: number, y: number) => inOval(x, y, 1) && Math.hypot(x - pin[0], y - pin[1]) > 0.022;
        const b: [number, number, number, number] = [ex - 0.12, ey - 0.1, ex + 0.12, ey + 0.1];
        marks.push({ pts: arc(ex, ey, rx, ry, 0, Math.PI * 2.1, 30, rot) });
        marks.push(...hatch(r, inSocket, b, between(r, 0.3, 0.8), 0.0065, 0.15));
        marks.push(...hatch(r, inSocket, b, between(r, -1.2, -0.8), 0.012, 0.15));
      }
      // the grin: nearly flat and thin across, then the corners shoot up the cheeks, almost to the edges of the face
      const w = frx * between(r, 0.98, 1.08);
      const my = fy + fry * between(r, 0.42, 0.5);
      const rise = between(r, 0.12, 0.17);
      const open = between(r, 0.045, 0.058);
      const up = (x: number) => my - rise * Math.abs(x / w) ** 3.2;
      const low = (x: number) => up(x) + open * (1 - Math.abs(x / w) ** 2.5) ** 0.5;
      const lip = (f: (x: number) => number): Pt[] => Array.from({ length: 45 }, (_, i) => -w + (2 * w * i) / 44).map((x): Pt => [fx + x, f(x)]);
      marks.push({ pts: lip(up) });
      marks.push({ pts: lip(low) });
      // small, thin, sharp teeth all the way along: a zigzag between the lips
      const n = 2 * Math.round(between(r, 13, 17));
      const teeth: Pt[] = [];
      for (let i = 0; i <= n; i++) {
        const x = -w * 0.92 + (1.84 * w * i) / n;
        teeth.push([fx + x, i % 2 ? low(x) : up(x)]);
      }
      marks.push({ pts: teeth, kind: "fine" });
      return marks;
    },
  },
];
