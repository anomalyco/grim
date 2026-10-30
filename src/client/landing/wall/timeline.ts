// The director: what happens when, counted from page load. Every timing is here. It only decides; the wall
// (index.ts) carries out each step with the pieces. With ?wall=debug, a panel to fire each step by hand, speed the
// clock up and see the phase. (The clock scale speeds up the schedule, not the animations: a punch still takes a
// punch's time, so a sped-up run shows the sequence with each piece looking as it will.)
import { rand } from "./core.ts";

export const TIMELINE = {
  /** the first punch (s from load) */
  firstPunch: 20,
  /** the punches, in order: "a" or "b" is a punch at that site, "A" the punch that breaks through site A. Four big
   *  ones, alternating; B ends cracked and lifted and holds. */
  order: "babA",
  /** gap between punches (s): random in this range */
  punchGap: [3, 5] as const,
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
  punchA(): void;
  punchB(): void;
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
      const k = TIMELINE.order[this.next++]!;
      if (k === "A") this.breakNow();
      else if (k === "a") s.punchA();
      else s.punchB();
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
  btn("Punch A", () => stage.punchA());
  btn("Punch B", () => stage.punchB());
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
