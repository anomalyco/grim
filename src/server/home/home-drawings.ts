// What moist-burrito draws (most of its turns: see AGENT_DRAWS in home-lines.ts): notebook doodles, weird and a little
// scary. Each drawing is its strokes, in the order a person would draw them, as polylines in a box 1 unit tall and
// `aspect` wide, centred on (0, 0), y down; `make` gets a random source, so no two come out the same (gaze, how many
// teeth, which joints bend). The bot draws them with its own pencil, stroke by stroke, like its writing
// (handwriting.ts drawPicture; the room places them like a line: home.ts).

export type Pt = [number, number];

export interface Drawing {
  id: string;
  /** width over height */
  aspect: number;
  /** hangs from the top of the bots' area (the spider): a thread is drawn first, from up there down to the box */
  hangs?: boolean;
  make(rand: () => number): Pt[][];
}

const between = (r: () => number, lo: number, hi: number) => lo + r() * (hi - lo);

/** an elliptical arc from angle a0 to a1 (radians; 0 is right, y down) */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n = 24): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
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

export const DRAWINGS: Drawing[] = [
  {
    // a single wide-open eye with lashes, staring out
    id: "eye",
    aspect: 1.8,
    make(r) {
      const w = 0.86;
      const open = between(r, 0.42, 0.5);
      const upper = curve([-w, 0.02], [0, -open * 1.25], [w, 0.02], 28);
      const lower = curve([w, 0.02], [0, open * 1.05], [-w, 0.02], 28);
      // the gaze wanders a little, but it's always looking at you
      const gx = between(r, -0.12, 0.12);
      const gy = between(r, -0.05, 0.06);
      const iris = arc(gx, gy, 0.27, 0.27, -Math.PI / 2, (Math.PI * 3) / 2, 30);
      // the pupil, filled in with a tight scribble
      const pupil: Pt[] = [];
      for (let i = 0; i <= 9; i++) {
        const y = gy - 0.11 + (0.22 * i) / 9;
        const half = Math.sqrt(Math.max(0, 0.11 ** 2 - (y - gy) ** 2));
        pupil.push([gx + (i % 2 ? half : -half), y]);
      }
      // lashes along the upper lid, pointing out from it
      const lashes: Pt[][] = [];
      const n = 7 + Math.floor(r() * 3);
      for (let i = 0; i < n; i++) {
        const t = 0.12 + (0.76 * i) / (n - 1);
        const k = Math.round(t * (upper.length - 1));
        const [x, y] = upper[k]!;
        const len = between(r, 0.14, 0.22);
        const out = (x / w) * 0.9;
        lashes.push([[x, y], [x + out * len, y - len]]);
      }
      return [[...upper, ...lower.slice(1)], iris, pupil, ...lashes];
    },
  },
  {
    // a wide grin full of far too many teeth, and no face around it
    id: "teeth",
    aspect: 2.4,
    make(r) {
      const w = 1.12;
      const lipTop = curve([-w, -0.22], [0, 0.18], [w, -0.22], 30);
      const lipBottom = curve([-w, -0.22], [0, 0.62], [w, -0.22], 30);
      // the gums, a little inside each lip
      const gumTop = (x: number) => -0.22 + 0.4 * (1 - (x / w) ** 2) * 0.5 + 0.05;
      const gumBottom = (x: number) => -0.22 + 0.84 * (1 - (x / w) ** 2) * 0.5 - 0.05;
      const row = (n: number, y: (x: number) => number, dir: number, tooth: number): Pt[] => {
        const out: Pt[] = [];
        const x0 = -w * 0.86;
        const step = (w * 1.72) / n;
        for (let i = 0; i < n; i++) {
          const a = x0 + i * step;
          const b = a + step;
          const h = tooth * between(r, 0.8, 1.2) * (1 - Math.abs((a + b) / 2 / w) * 0.6);
          out.push([a, y(a)], [a, y(a) + dir * h], [b, y(b) + dir * h], [b, y(b)]);
        }
        return out;
      };
      const top = row(14 + Math.floor(r() * 6), gumTop, 1, 0.13);
      const bottom = row(13 + Math.floor(r() * 6), gumBottom, -1, 0.11);
      return [lipTop, lipBottom, top, bottom];
    },
  },
  {
    // a spider on its thread (the room draws the thread down from the top first: `hangs`), then its body and legs
    id: "spider",
    aspect: 1.25,
    hangs: true,
    make(r) {
      const body = arc(0, 0.12, 0.17, 0.2, -Math.PI / 2, (Math.PI * 3) / 2, 26);
      const head = arc(0, -0.17, 0.09, 0.08, Math.PI / 2, Math.PI / 2 + Math.PI * 2, 16);
      const legs: Pt[][] = [];
      for (const side of [-1, 1])
        for (let i = 0; i < 4; i++) {
          const y = -0.06 + i * 0.09;
          const knee: Pt = [side * between(r, 0.36, 0.44), y - between(r, 0.16, 0.24) + i * 0.05];
          const foot: Pt = [side * between(r, 0.5, 0.6), y + between(r, 0.12, 0.3) + i * 0.06];
          legs.push([[side * 0.12, y], knee, foot]);
        }
      return [head, body, ...legs];
    },
  },
  {
    // a smiling stick figure whose long arms bend at one or two joints too many
    id: "figure",
    aspect: 1.2,
    make(r) {
      const head = arc(0, -0.34, 0.12, 0.13, -Math.PI / 2, (Math.PI * 3) / 2, 22);
      const smile = arc(0, -0.35, 0.07, 0.05, Math.PI * 0.15, Math.PI * 0.85, 10);
      const body: Pt[] = [[0, -0.21], [0, 0.16]];
      const legs: Pt[][] = [
        [[0, 0.16], [-0.12, 0.33], [-0.16, 0.5]],
        [[0, 0.16], [0.12, 0.33], [0.17, 0.5]],
      ];
      // each arm: three or four bones, each turning sharply (some the wrong way)
      const arm = (side: number): Pt[] => {
        const out: Pt[] = [[0, -0.12]];
        let a = side > 0 ? between(r, -0.3, 0.3) : Math.PI + between(r, -0.3, 0.3);
        const bones = 3 + Math.floor(r() * 2);
        for (let i = 0; i < bones; i++) {
          const [x, y] = out[out.length - 1]!;
          const len = between(r, 0.11, 0.16);
          out.push([x + Math.cos(a) * len, y + Math.sin(a) * len]);
          a += side * (r() < 0.6 ? 1 : -1) * between(r, 0.9, 1.6);
        }
        return out;
      };
      return [head, smile, body, ...legs, arm(-1), arm(1)];
    },
  },
];
