// The home page doodle: pencils (people and server-side bots) drawing on a shared page over /ws/home.
//
// Coordinates are page units: x is CSS px from the horizontal centre of the page (negative = left), y is CSS px
// from the top of the page. The home page centres all its content, so a mark made next to the editor lines up for
// everyone whatever their window width. Nothing is saved: the server keeps recent strokes in memory only.
//
// Marks don't last: every point fades away inkLifeMs after it was drawn (over its last inkFadeMs), so a pencil leaves a
// trail behind it. Clients time points by when they show up (after playback); newcomers get each batch's age.
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
//                                     strokes = Stroke[] (recent ones, roughly oldest first, only their points that
//                                     are still showing); b gives their points' ages as of `d` ms ago
//     {t:"j", peers}              people arrived (Peer[]; batched, may repeat someone you already know)
//     {t:"c", id, x, y, z?, h?}   a pencil moved (z: height above the paper in px, bots only; h: hidden)
//     {t:"s", id, u, c, w, p, e?} points of stroke id by peer u in colour c, w = line width; e: the pen lifted (also
//                                 sent with no points when its owner leaves or starts another stroke)
//     {t:"l", ids}                people left (batched)

export interface Peer {
  id: string;
  name: string;
  color: string;
  bot?: boolean;
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
}

export const DOODLE = {
  /** page-unit bounds every coordinate is clamped to */
  minX: -1600,
  maxX: 1600,
  minY: 0,
  maxY: 6000,
  /** the area bots write in (above the fold on any desktop window), narrowed to the smallest window connected */
  bot: { minX: -560, maxX: 560, minY: 110, maxY: 770 },
  /** every point shows for this long after it's drawn, fading out over the last part */
  inkLifeMs: 12_000,
  inkFadeMs: 7_000,
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

/** Muted pencil colours (no bright red). */
export const PENCIL_COLORS = ["#296d9a", "#4f7d4a", "#c08a2e", "#6b4f8f", "#2f7f7a", "#4a4f57", "#c4692f", "#2c4a6e", "#8a5a72", "#7a8a3a"];

export const SAYINGS = [
  "two heads, one cursor",
  "the robot took the todo",
  "who wrote this? (me)",
  "merge conflict? never heard of her",
  "agents are people too (legally no)",
  "ctrl+z is a love language",
  "i'll fix it in the next commit",
  "the agent says hi",
  "hand it to the robot",
  "pair programming but louder",
  "typing... still typing...",
  "my cursor, my rules",
  "sorry, was that your line?",
  "the bot wrote a haiku",
  "git blame: the cat",
  "one shared brain cell",
  "we're all just cursors",
  "three people, one comma",
  "the agent needs a nap",
  "lgtm (did not look)",
  "fixed it! (broke it)",
  "hello from the other tab",
  "who moved my heading",
  "the todo did itself",
  "collaborate or else",
  "markdown, but together",
  "i saw that typo",
  "robots do the dishes now",
  "let's circle back. literally",
  "plz no edit war",
  "the agent ate my homework",
  "many hands, light notes",
  "haunted by friendly cursors",
  "who's typing in my doc?",
  "i'm the agent now",
  "committed. emotionally too",
  "the robot agreed with me",
  "this note has 4 authors",
  "teamwork makes the diff work",
  "beep boop, done",
  "hi from a pencil",
  "human in the loop (barely)",
  "the cursor knows",
  "ship it (gently)",
  "agents love a checklist",
  "wait, who's the robot here",
  "same page, literally",
  "trust but git log",
  "i'll take the next bullet",
  "you take the left margin",
  "ask the agent, blame the agent",
  "two cursors walk into a doc",
  "it works on my tab",
  "live, laugh, line edit",
  "everyone's a co-author",
  "the bot did a doodle",
  "stop scribbling on my todo",
  "many cursors, zero meetings",
  "thank u, next commit",
  "pencil > keyboard (sometimes)",
  "the robot is learning cursive",
  "not a bug, a collab",
  "rubber duck, but it answers",
  "brb, agent is driving",
];
