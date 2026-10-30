// The director: what happens when, counted from page load. Every timing is here. It only decides; the wall
// (index.ts) carries out each step with the pieces. With ?wall=debug, a panel to fire each step by hand, speed the
// clock up and see the phase. (The clock scale speeds up the schedule, not the animations: a punch still takes a
// punch's time, so a sped-up run shows the sequence with each piece looking as it will.)
import { rand } from "./core.ts";
import type { Strength } from "./punches.ts";

export const TIMELINE = {
  /** the first punch (s from load) */
  firstPunch: 30,
  /** the punches, in order: "a" or "b" is a punch at that site, "A" the punch that breaks through site A. Four,
   *  alternating, getting stronger; B ends cracked and lifted and holds. */
  order: "babA",
  /** gap between punches (s): random in this range */
  punchGap: [5, 8] as const,
  /** how hard each punch is, in order (the debug panel's buttons take the next; any after the last are like the
   *  last). Ranges are random picks.
   *   reach    cracks every edge out to this fraction of the fracture's radius (never less than the site already has)
   *   runs     long cracks running on past that
   *   lifts    plates tipping up; tilt: a fresh plate's tilt (degrees); more: one already up tips this much further
   *   popFree  the chance a lifted plate pops partly free of the wall
   *   crumbs   per lifted plate; chunks: bigger bits from round the impact
   *   jolt     the page's jolt (px) */
  punches: [
    { reach: 0.38, runs: [1, 2], lifts: [1, 2], tilt: [10, 15], more: [4, 6], popFree: 0, crumbs: [2, 4], chunks: [0, 1], jolt: [1.4, 2] },
    { reach: 0.45, runs: [2, 3], lifts: [1, 2], tilt: [12, 17], more: [4, 6], popFree: 0, crumbs: [3, 4], chunks: [1, 1], jolt: [1.8, 2.4] },
    { reach: 0.68, runs: [3, 4], lifts: [2, 3], tilt: [20, 30], more: [8, 12], popFree: 0.15, crumbs: [4, 6], chunks: [1, 2], jolt: [2.5, 3.2] },
    { reach: 0.85, runs: [3, 5], lifts: [2, 4], tilt: [30, 46], more: [8, 14], popFree: 0.35, crumbs: [5, 8], chunks: [2, 4], jolt: [4.5, 5] },
  ] as Strength[],
  /** after the breakthrough, one quick widening punch this long after (s; 0: none), knocking out this many more
   *  plates, no further out than `widenReach` of the fracture's radius */
  widenAfter: [1.1, 1.6] as const,
  widenPunches: 1,
  widenPieces: [3, 4] as const,
  widenReach: 0.72,
  /** crawlers: the first this long (s) after the hole is open, then the stream: the next after `pourFirst` s, each
   *  gap `pourShrink` times the last, down to `pourMin` s, with `pourJitter` (a fraction) of randomness. While
   *  CRAWLER.max are out, the next waits. */
  crawlersAfter: 3,
  pourFirst: 6,
  pourShrink: 0.8,
  pourMin: 0.7,
  pourJitter: 0.3,
};

/** What the director can make happen, and what it needs to know. */
export interface Stage {
  /** a punch at the site, as hard as punch `n` (0-based, in TIMELINE.punches) */
  punchA(n: number): void;
  punchB(n: number): void;
  breakThrough(): void;
  /** one more widening punch; true when the hole's as big as it gets */
  widen(): boolean;
  /** the whole opening at once (the debug panel) */
  openHole(): void;
  bloodScratch(): void;
  /** false if none could come out (too many out already) */
  spawnCrawler(): boolean;
  reset(): void;
  readonly punchesA: number;
  readonly punchesB: number;
  readonly lifting: boolean;
  readonly cracked: boolean;
  readonly broken: boolean;
  readonly crawlers: number;
}

type Phase = "calm" | "punching" | "cracking" | "lifting" | "broken" | "hole" | "crawlers";

export class Director {
  time = 0;
  scale = 1;
  /** the next punch in TIMELINE.order, and when */
  private next = 0;
  private nextAt = TIMELINE.firstPunch;
  private widenLeft = 0;
  private nextWiden = Infinity;
  private open = false;
  private nextCrawler = Infinity;
  private pourGap = TIMELINE.pourFirst;
  phase: Phase = "calm";

  constructor(private stage: Stage) {}

  reset() {
    this.time = 0;
    this.next = 0;
    this.nextAt = TIMELINE.firstPunch;
    this.widenLeft = 0;
    this.nextWiden = Infinity;
    this.open = false;
    this.nextCrawler = Infinity;
    this.pourGap = TIMELINE.pourFirst;
    this.phase = "calm";
  }

  /** Straight to the full stream (the debug panel's Flood). */
  flood() {
    this.pourGap = TIMELINE.pourMin;
    this.nextCrawler = this.time;
  }

  /** dt: real seconds since the last frame */
  update(dt: number) {
    this.time += dt * this.scale;
    const t = this.time;
    const s = this.stage;
    if (t >= this.nextAt && this.next < TIMELINE.order.length) {
      const n = this.next++;
      const k = TIMELINE.order[n]!;
      if (k === "A") this.breakNow();
      else if (k === "a") s.punchA(n);
      else s.punchB(n);
      this.nextAt = t + rand(...TIMELINE.punchGap);
    }
    if (t >= this.nextWiden) {
      const done = s.widen() || --this.widenLeft <= 0;
      this.nextWiden = done ? Infinity : t + rand(...TIMELINE.widenAfter);
      if (done) this.opened();
    }
    if (t >= this.nextCrawler) {
      if (s.spawnCrawler()) {
        const j = TIMELINE.pourJitter;
        this.nextCrawler = t + this.pourGap * rand(1 - j, 1 + j);
        this.pourGap = Math.max(TIMELINE.pourMin, this.pourGap * TIMELINE.pourShrink);
      } else this.nextCrawler = t + 0.25;
    }
    this.phase =
      s.crawlers > 0 ? "crawlers"
      : this.open ? "hole"
      : s.broken ? "broken"
      : s.lifting ? "lifting"
      : s.cracked ? "cracking"
      : s.punchesA + s.punchesB > 0 ? "punching"
      : "calm";
  }

  /** Break through now, then widen once (or not) and open (the schedule's last punch, or the debug panel). */
  breakNow() {
    this.next = TIMELINE.order.length;
    this.stage.breakThrough();
    this.widenLeft = TIMELINE.widenPunches;
    if (this.widenLeft > 0) this.nextWiden = this.time + rand(...TIMELINE.widenAfter);
    else this.opened();
  }

  /** The hole's open (on schedule or by hand): crawlers next. */
  opened() {
    if (this.open) return;
    this.open = true;
    this.nextWiden = Infinity;
    this.nextCrawler = Math.min(this.nextCrawler, this.time + TIMELINE.crawlersAfter);
  }
}

/** The ?wall=debug panel: a button per step, the clock's speed, and where we are. Returns its teardown. */
export function debugPanel(director: Director, stage: Stage): { el: HTMLElement; tick: () => void } {
  const el = document.createElement("div");
  el.className = "wall-debug";
  const readout = document.createElement("div");
  readout.className = "wall-debug-readout";
  const row = document.createElement("div");
  row.className = "wall-debug-row";
  const btn = (label: string, f: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.onclick = f;
    row.append(b);
  };
  btn("Punch A", () => stage.punchA(stage.punchesA + stage.punchesB));
  btn("Punch B", () => stage.punchB(stage.punchesA + stage.punchesB));
  btn("Break through", () => director.breakNow());
  btn("Widen", () => {
    if (stage.widen()) director.opened();
  });
  btn("Blood scratch", () => stage.bloodScratch());
  btn("Spawn crawler", () => stage.spawnCrawler());
  btn("Flood", () => director.flood());
  btn("Reset", () => {
    director.reset();
    stage.reset();
  });
  const speed = document.createElement("label");
  speed.className = "wall-debug-speed";
  const range = document.createElement("input");
  range.type = "range";
  range.min = "1";
  range.max = "20";
  range.step = "1";
  range.value = String(director.scale);
  const val = document.createElement("span");
  val.textContent = `${director.scale}×`;
  range.oninput = () => {
    director.scale = Number(range.value);
    val.textContent = `${director.scale}×`;
  };
  speed.append("time ", range, val);
  el.append(readout, row, speed);
  let last = "";
  const tick = () => {
    const t = director.time;
    const m = Math.floor(t / 60);
    const sec = Math.floor(t % 60).toString().padStart(2, "0");
    const text = `${m}:${sec} · ${director.phase} · A ${stage.punchesA} · B ${stage.punchesB} · crawlers ${stage.crawlers} live`;
    if (text !== last) readout.textContent = last = text;
  };
  return { el, tick };
}
