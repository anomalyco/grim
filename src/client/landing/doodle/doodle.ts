// The landing page doodle: your pencil and three bots' pencils drawing on the page, all in your browser (the bots'
// engine: ../bots/engine.ts). Nothing is sent anywhere or kept: every page load starts afresh.
//
// Coordinates are page units: x is CSS px from the horizontal centre of the page (negative = left), y is CSS px
// from the top of the page. The page centres all its content, so the bots' area lines up with it whatever the
// window's width.
//
// Marks don't last: ink stays until INK_MS after it's finished, then fades over INK_FADE_MS. Your stroke is finished
// at its end; a bot's strokes when the line or drawing they're part of is.
//
// The engine tells the page what the bots do with messages (page units):
//   {t:"c", id, x, y, z, g?}       a bot's pencil moved (z: height above the paper in px; g: it's between lines)
//   {t:"s", id, u, c, w, p, e?}    points of stroke id by bot u in colour c, w = line width: p = [x, y, pressure, …]
//                                  (pressure 0..1); e: the pen lifted
//   {t:"d", ids}                   a bot finished the line or drawing these strokes are: their ink fades INK_MS on

/** A pencil on the page (a bot's): who it is, and where (page units). */
export interface Peer {
  id: string;
  name: string;
  color: string;
  bot?: boolean;
  x?: number;
  y?: number;
}

export const DOODLE = {
  /** page-unit bounds every coordinate is clamped to */
  minX: -1600,
  maxX: 1600,
  minY: 0,
  maxY: 6000,
  /** the area bots write in (above the fold on any desktop window), narrowed to the window */
  bot: { minX: -560, maxX: 560, minY: 110, maxY: 770 },
  /** how often the bots move (ms); the page plays each step's points back over this interval */
  batchMs: 50,
};

/** How long ink stays once it's finished (ms): your stroke from its end, a bot's line or drawing from its last
 *  stroke. Then it fades out over INK_FADE_MS. The one place to tune it. */
export const INK_MS = 10_000;
export const INK_FADE_MS = 1_500;

/** Muted pencil colours (no bright red). */
export const PENCIL_COLORS = ["#296d9a", "#4f7d4a", "#c08a2e", "#6b4f8f", "#2f7f7a", "#4a4f57", "#c4692f", "#2c4a6e", "#8a5a72", "#7a8a3a"];

/** Pencils on the page together are at least this far apart in colour (CIE76 ΔE in Lab): blue and navy (16), ochre
 *  and orange (22) or green and olive (20) never meet. */
export const MIN_COLOR_DE = 28;

/** `n` colours from the palette at random, no two alike (at least MIN_COLOR_DE apart): a fresh set every page load,
 *  for your pencil and the bots'. */
export function pickPencilColors(n: number, rand: () => number = Math.random): string[] {
  for (let min = MIN_COLOR_DE; ; min -= 2) {
    for (let tries = 0; tries < 40; tries++) {
      const pool = PENCIL_COLORS.map((c) => [rand(), c] as const).sort((a, b) => a[0] - b[0]).map(([, c]) => c);
      const picked: string[] = [];
      for (const c of pool) if (picked.every((p) => colorDistance(p, c) >= min) && picked.push(c) === n) return picked;
    }
    if (min <= 0) return PENCIL_COLORS.slice(0, n);
  }
}

/** How different two #rrggbb colours look: CIE76 ΔE, in Lab. */
export function colorDistance(a: string, b: string): number {
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

function lab(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [x, y, z] = [f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), f(0.2126 * r + 0.7152 * g + 0.0722 * b), f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883)];
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
