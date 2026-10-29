// What moist-burrito draws (most of its turns: see AGENT_DRAWS in home-lines.ts): notebook doodles of the monster
// invasion, and other weird, a little scary things. Add more freely: the room picks among all of these. Each drawing
// is its strokes, in the order a person would draw them, as polylines in a box 1 unit tall and `aspect` wide, centred
// on (0, 0), y down; `make` gets a random source, so no two come out the same (gaze, how many eyes and teeth, which
// joints bend). The bot draws them with its own pencil, stroke by stroke, like its writing (handwriting.ts
// drawPicture; the room places them like a line: home.ts).

export type Pt = [number, number];

export interface Drawing {
  id: string;
  /** width over height */
  aspect: number;
  /** hangs from the top of the bots' area (the spider): a thread is drawn first, from up there down to the box */
  hangs?: boolean;
  /** how tall it's drawn, in px on a desktop (smaller on a phone); default 80-160. The little ones are margin doodles. */
  height?: [number, number];
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

/** a closed, lumpy loop round (cx, cy): `wob` how lumpy */
function blobLoop(r: () => number, cx: number, cy: number, rx: number, ry: number, wob: number, n = 40): Pt[] {
  const p1 = r() * 6;
  const p2 = r() * 6;
  const k = 2 + Math.floor(r() * 3);
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (Math.PI * 2 * i) / n;
    const m = 1 + wob * (Math.sin(k * a + p1) * 0.7 + Math.sin((k + 2) * a + p2) * 0.3);
    out.push([cx + Math.cos(a) * rx * m, cy + Math.sin(a) * ry * m]);
  }
  return out;
}

/** a pupil: a small disc filled in with a tight back-and-forth scribble */
function pupilFill(cx: number, cy: number, rad: number, n = 6): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const y = cy - rad + (2 * rad * i) / n;
    const half = Math.sqrt(Math.max(0, rad ** 2 - (y - cy) ** 2));
    out.push([cx + (i % 2 ? half : -half), y]);
  }
  return out;
}

/** a little eye: a circle and its pupil, looking towards (lx, ly) */
function littleEye(cx: number, cy: number, rad: number, lx: number, ly: number): Pt[][] {
  const ring = arc(cx, cy, rad, rad, -Math.PI / 2, (Math.PI * 3) / 2, Math.max(10, Math.round(rad * 160)));
  return [ring, pupilFill(cx + lx * rad * 0.4, cy + ly * rad * 0.4, rad * 0.45, 4)];
}

/** a wavy line from a to b: `amp` across it, `waves` half-waves along it */
function wavy(a: Pt, b: Pt, amp: number, waves: number, ph = 0, n = 24): Pt[] {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len = Math.hypot(dx, dy) || 1;
  const [nx, ny] = [-dy / len, dx / len];
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const o = Math.sin(ph + t * Math.PI * waves) * amp;
    out.push([a[0] + dx * t + nx * o, a[1] + dy * t + ny * o]);
  }
  return out;
}

/** one loose eyeball at (cx, cy): its ball, iris and pupil (glancing somewhere), a few veins, and maybe its nerve */
function eyeball(r: () => number, cx: number, cy: number, R: number): Pt[][] {
  const ball = blobLoop(r, cx, cy, R, R * between(r, 0.94, 1.04), 0.025, 34);
  const g = r() * Math.PI * 2;
  const off = between(r, 0.15, 0.4) * R;
  const [ix, iy] = [cx + Math.cos(g) * off, cy + Math.sin(g) * off];
  const iris = arc(ix, iy, R * 0.42, R * 0.42, -Math.PI / 2, (Math.PI * 3) / 2, 22);
  const pupil = pupilFill(ix, iy, R * 0.2, 5);
  // veins: wiggly, from the rim in towards the iris (not over it), now and then forking
  const veins: Pt[][] = [];
  const nv = 2 + Math.floor(r() * 3);
  for (let i = 0; i < nv; i++) {
    const a = g + Math.PI + between(r, -1.4, 1.4);
    const from: Pt = [cx + Math.cos(a) * R * 0.97, cy + Math.sin(a) * R * 0.97];
    const to: Pt = [cx + Math.cos(a + between(r, -0.3, 0.3)) * R * 0.5, cy + Math.sin(a + between(r, -0.3, 0.3)) * R * 0.5];
    const v = wavy(from, to, R * 0.05, between(r, 3, 5), r() * 6, 12);
    veins.push(v);
    if (r() < 0.5) {
      const [mx, my] = v[6]!;
      const b = a + (r() < 0.5 ? 1 : -1) * between(r, 0.5, 0.9);
      veins.push(wavy([mx, my], [mx - Math.cos(b) * R * 0.22, my - Math.sin(b) * R * 0.22], R * 0.03, 3, r() * 6, 6));
    }
  }
  const out = [ball, iris, pupil, ...veins];
  // the optic nerve trailing off behind it, sometimes
  if (r() < 0.5) {
    const a = g + Math.PI + between(r, -0.5, 0.5);
    const from: Pt = [cx + Math.cos(a) * R, cy + Math.sin(a) * R];
    const len = R * between(r, 0.7, 1.1);
    out.push(curve(from, [from[0] + Math.cos(a + 0.6) * len * 0.6, from[1] + Math.sin(a + 0.6) * len * 0.6], [from[0] + Math.cos(a - 0.2) * len, from[1] + Math.sin(a - 0.2) * len], 14));
  }
  return out;
}

/** keep a drawing's points inside its box (aspect wide, 1 tall), scaling it down round the centre if it strays */
function fit(strokes: Pt[][], aspect: number): Pt[][] {
  let m = 0;
  for (const st of strokes) for (const [x, y] of st) m = Math.max(m, Math.abs(x) / (aspect / 2), Math.abs(y) / 0.5);
  if (m <= 1) return strokes;
  return strokes.map((st) => st.map(([x, y]): Pt => [x / m, y / m]));
}

/** the little monsters' size: margin doodles */
const LITTLE: [number, number] = [55, 100];

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
  {
    // a little monster: a lumpy blob with far too many eyes, a wobbly mouth, and stubby legs
    id: "blob",
    aspect: 1.3,
    height: LITTLE,
    make(r) {
      const body = blobLoop(r, 0, -0.02, 0.5, 0.34, 0.07);
      const look: Pt = [between(r, -1, 1), between(r, -0.5, 1)];
      const eyes: Pt[][] = [];
      const n = 4 + Math.floor(r() * 4);
      const spots: [number, number, number][] = [];
      for (let tries = 0; spots.length < n && tries < 200; tries++) {
        const rad = between(r, 0.035, 0.085);
        const x = between(r, -0.36, 0.36);
        const y = between(r, -0.26, 0.02);
        if (spots.every(([sx, sy, sr]) => Math.hypot(x - sx, y - sy) > rad + sr + 0.03)) spots.push([x, y, rad]);
      }
      for (const [x, y, rad] of spots) eyes.push(...littleEye(x, y, rad, look[0], look[1]));
      const mouth = wavy([-0.16, 0.13], [0.16, 0.13], 0.025, between(r, 3, 6), r() * 6, 16);
      const legs: Pt[][] = [];
      const nl = 3 + Math.floor(r() * 3);
      for (let i = 0; i < nl; i++) {
        const x = -0.3 + (0.6 * i) / (nl - 1) + between(r, -0.03, 0.03);
        const top = 0.26 - Math.abs(x) * 0.25;
        const foot = between(r, 0.42, 0.48);
        const toe = (r() < 0.5 ? -1 : 1) * 0.05;
        legs.push([[x, top], [x + between(r, -0.02, 0.02), foot], [x + toe, foot + 0.01]]);
      }
      return fit([body, ...eyes, mouth, ...legs], 1.3);
    },
  },
  {
    // a little monster: tall and thin, a tiny head, and arms that hang down far too long
    id: "lanky",
    aspect: 0.8,
    height: LITTLE,
    make(r) {
      const lean = between(r, -0.06, 0.06);
      const head = blobLoop(r, lean, -0.43, 0.055, 0.05, 0.05, 14);
      const eyes: Pt[][] = [
        [[lean - 0.022, -0.44], [lean - 0.018, -0.43]],
        [[lean + 0.018, -0.44], [lean + 0.022, -0.43]],
      ];
      const body = curve([lean * 0.8 - 0.025, -0.38], [lean * 0.3 - 0.04, -0.05], [-0.03, 0.22], 16).concat(curve([0.03, 0.22], [lean * 0.3 + 0.04, -0.05], [lean * 0.8 + 0.025, -0.38], 16));
      const legs: Pt[][] = [
        [[-0.03, 0.22], [-0.06 + between(r, -0.02, 0.02), 0.36], [-0.08, 0.5]],
        [[0.03, 0.22], [0.06 + between(r, -0.02, 0.02), 0.36], [0.09, 0.5]],
      ];
      const arm = (side: number): Pt[][] => {
        const sx = lean * 0.75 + side * 0.03;
        const end: Pt = [side * between(r, 0.26, 0.34), between(r, 0.3, 0.44)];
        // out from the shoulder, then hanging down, a bit bent
        const line = curve([sx, -0.33], [side * between(r, 0.42, 0.5), between(r, -0.3, -0.12)], end, 18);
        // three long fingers
        const fingers: Pt[][] = [-0.45, 0, 0.45].map((d) => {
          const a = Math.PI / 2 + side * 0.3 + d;
          return [end, [end[0] + Math.cos(a) * 0.06, end[1] + Math.sin(a) * 0.06]];
        });
        return [line, ...fingers];
      };
      return fit([head, ...eyes, body, ...legs, ...arm(-1), ...arm(1)], 0.8);
    },
  },
  {
    // a little monster: a round furry thing, nearly all mouth, with a wide grin of pointed teeth
    id: "fuzzball",
    aspect: 1.1,
    height: LITTLE,
    make(r) {
      // fur: the outline in little zigzags
      const fur: Pt[] = [];
      const n = 34 + Math.floor(r() * 10);
      for (let i = 0; i <= n; i++) {
        const a = -Math.PI / 2 + (Math.PI * 2 * i) / n;
        const rad = (i % 2 ? 0.44 : 0.38) + between(r, -0.02, 0.02);
        fur.push([Math.cos(a) * rad, Math.sin(a) * rad * 0.95 - 0.02]);
      }
      fur[fur.length - 1] = fur[0]!;
      const look: Pt = [between(r, -1, 1), between(r, -1, 0.5)];
      const big = r() < 0.4;
      const eyes = [...littleEye(-0.13, -0.17, big ? 0.09 : 0.065, look[0], look[1]), ...littleEye(0.13, -0.17, 0.065, look[0], look[1])];
      const w = between(r, 0.22, 0.28);
      const top = -0.01;
      const lip = curve([-w, top], [0, top + between(r, 0.32, 0.4)], [w, top], 22);
      const teeth: Pt[] = [];
      const nt = 6 + Math.floor(r() * 4);
      for (let i = 0; i <= nt * 2; i++) {
        const x = -w + (2 * w * i) / (nt * 2);
        teeth.push([x, top + (i % 2 ? between(r, 0.06, 0.1) * (1 - (x / w) ** 2 * 0.6) : 0)]);
      }
      const feet: Pt[][] = [-0.15, 0.15].map((x) => arc(x, 0.43, 0.07, 0.04, Math.PI, Math.PI * 2, 8));
      return fit([fur, ...eyes, [[-w, top], [w, top]], teeth, lip, ...feet], 1.1);
    },
  },
  {
    // a little monster: a tentacled lump peeking up over a line, its tentacles curling over the edge
    id: "peeker",
    aspect: 1.6,
    height: LITTLE,
    make(r) {
      const edge = 0.12;
      const x0 = between(r, -0.15, 0.15);
      const ledge = wavy([-0.75, edge], [0.75, edge], 0.006, 4, r() * 6, 30);
      const dome = arc(x0, edge, between(r, 0.28, 0.34), between(r, 0.36, 0.44), Math.PI, Math.PI * 2, 26);
      const look = r() < 0.5 ? -1 : 1;
      const eyes = [...littleEye(x0 - 0.1, edge - 0.18, 0.06, look, 0.3), ...littleEye(x0 + 0.1, edge - 0.18, 0.06, look, 0.3)];
      const tentacles: Pt[][] = [];
      const nt = 3 + Math.floor(r() * 2);
      for (let i = 0; i < nt; i++) {
        const side = i % 2 ? 1 : -1;
        const sx = x0 + side * between(r, 0.12, 0.3);
        const ex = sx + side * between(r, 0.12, 0.3);
        const ey = edge + between(r, 0.2, 0.32);
        const t = curve([sx, edge], [sx + side * 0.2, edge - 0.05], [ex, ey], 14);
        // its tip curls back on itself
        const curl = arc(ex - side * 0.04, ey, 0.04, 0.04, side > 0 ? 0 : Math.PI, side > 0 ? Math.PI * 1.4 : -Math.PI * 0.4, 10);
        tentacles.push([...t, ...curl.slice(1)]);
      }
      return fit([ledge, dome, ...eyes, ...tentacles], 1.6);
    },
  },
  {
    // loose eyeballs, rolling about: one, or a little cluster of two or three
    id: "eyeballs",
    aspect: 1.6,
    height: [45, 90],
    make(r) {
      const k = r();
      const spots: [number, number, number][] =
        k < 0.4 ? [[between(r, -0.1, 0.1), 0, 0.34]]
        : k < 0.75 ? [[-0.34, between(r, -0.06, 0.06), 0.27], [0.36, between(r, -0.06, 0.08), between(r, 0.2, 0.25)]]
        : [[-0.42, 0.12, 0.22], [0.02, -0.16, 0.2], [0.43, 0.14, between(r, 0.18, 0.22)]];
      return fit(spots.flatMap(([x, y, R]) => eyeball(r, x, y, R)), 1.6);
    },
  },
];
