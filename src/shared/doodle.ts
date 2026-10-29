// The home page doodle: pencils (people and server-side bots) drawing on a shared page over /ws/home.
//
// Coordinates are page units: x is CSS px from the horizontal centre of the page (negative = left), y is CSS px
// from the top of the page. The home page centres all its content, so a mark made next to the editor lines up for
// everyone whatever their window width. Nothing is saved: the server keeps recent strokes in memory only.
//
// Marks don't last: ink stays until INK_MS after it's finished, then fades over INK_FADE_MS. A person's stroke is
// finished at its end; a bot's strokes when the line or drawing they're part of is ({t:"d", ids}, below). Newcomers
// get how long ago each stroke was finished (`dn`), or none while it isn't.
//
// Messages are small JSON text frames (a binary or oversized frame closes the connection).
//   client → server
//     {t:"c", x, y}               where my pencil is (throttled, ~20/s); {t:"c", h:1} hides it (left the page or
//                                 hovering something interactive)
//     {t:"v", w, h}               the paper I can see: my window's width and its height down to the bottom of the
//                                 blank paper (CSS px); the bots keep to what every window here shows
//     {t:"s", k, p, e?}           points of my stroke k (client-chosen integer): p = [x, y, pressure, …] (pressure
//                                 0..1), e:1 when the pen lifts. A new k ends the previous stroke.
//   server → client
//     {t:"hi", you, peers, d, strokes}   on connect: you = Peer; peers = Peer[] (others, bots included);
//                                     strokes = Stroke[] (recent ones still showing, roughly oldest first); b gives
//                                     their points' ages and dn how long ago they were finished, as of `d` ms ago
//     {t:"j", peers}              people arrived (Peer[]; batched, may repeat someone you already know)
//     {t:"c", id, x, y, z?, h?}   a pencil moved (z: height above the paper in px, bots only; h: hidden)
//     {t:"s", id, u, c, w, p, e?} points of stroke id by peer u in colour c, w = line width; e: the pen lifted (also
//                                 sent with no points when its owner leaves or starts another stroke)
//     {t:"l", ids}                people left (batched)
//     {t:"d", ids}                a bot finished the line or drawing these strokes are: their ink fades INK_MS on

export interface Peer {
  id: string;
  name: string;
  color: string;
  bot?: boolean;
  /** a person's: the page (tab) they're on, and who they are across their tabs (random ids their page makes; a page
   *  never draws its own tab's pencil, nor its person's other tabs') */
  tab?: string;
  v?: string;
  x?: number;
  y?: number;
}

export interface Stroke {
  id: number;
  u: string;
  c: string;
  w: number;
  p: number[];
  /** the points in batches: [count, age in ms when sent, count, age, …], in order */
  b: number[];
  /** still being drawn */
  o?: boolean;
  /** finished this long ago (ms, as of the hello's `d`): its ink fades INK_MS after; missing while it isn't */
  dn?: number;
}

export const DOODLE = {
  /** page-unit bounds every coordinate is clamped to */
  minX: -1600,
  maxX: 1600,
  minY: 0,
  maxY: 6000,
  /** the area bots write in (above the fold on any desktop window), narrowed to the smallest window connected */
  bot: { minX: -560, maxX: 560, minY: 110, maxY: 770 },
  maxStrokes: 2000,
  maxBufferedPoints: 150_000,
  maxPointsPerMessage: 64,
  maxPointsPerStroke: 2000,
  maxMessageBytes: 4096,
  /** per connection: messages and points per second (token buckets with a burst of 2 s) */
  msgsPerSec: 40,
  pointsPerSec: 400,
  maxConnsPerIp: 6,
  maxConns: 300,
  /** how often stroke points are sent in batches (ms); playback spreads a batch over this interval */
  batchMs: 50,
};

/** How long ink stays once it's finished (ms): a person's stroke from its end, a bot's line or drawing from its last
 *  stroke. Then it fades out over INK_FADE_MS. The one place to tune it. */
export const INK_MS = 10_000;
export const INK_FADE_MS = 1_500;

/** Muted pencil colours (no bright red). */
export const PENCIL_COLORS = ["#296d9a", "#4f7d4a", "#c08a2e", "#6b4f8f", "#2f7f7a", "#4a4f57", "#c4692f", "#2c4a6e", "#8a5a72", "#7a8a3a"];
