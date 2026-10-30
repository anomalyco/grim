// The director: what happens when, counted from page load. Every timing is here. It only decides; the wall
// (index.ts) carries out each step with the pieces. With ?wall=debug, a panel to fire each step by hand, speed the
// clock up and see the phase. (The clock scale speeds up the schedule, not the animations: a punch still takes a
// punch's time, so a sped-up run shows the sequence with each piece looking as it will.)
import { lerp, rand } from "./core.ts";

export const TIMELINE = {
  /** the first punch (s from load), at site A; site B starts this much later */
  punchStart: 15,
  siteBDelay: 2.5,
  /** gap between punches at a site (s): irregular, now and then a quick double; the gaps shorten as it goes, the
   *  last ones `escalate` times the first */
  punchGap: [1.4, 3.2] as const,
  doubleChance: 0.22,
  doubleGap: [0.18, 0.32] as const,
  escalate: 0.5,
  /** punches at each site: A then breaks through; B stops there, cracked and lifted, and holds */
  punchesA: 13,
  punchesB: 8,
  /** after A's last punch, the breakthrough (s) */
  breakAfter: [0.9, 1.5] as const,
  /** then the hole widens: this many more punches, this far apart (s), each knocking out this many plates */
  widenPunches: 3,
  widenGap: [1, 1.9] as const,
  widenPieces: [2, 3] as const,
  /** the widening stops at plates this far out (a fraction of the fracture's radius): the rest stay, a ragged rim */
  widenReach: 0.6,
  /** crawlers: the first this long (s) after the hole is open, then the stream: the next after `pourFirst` s, each
   *  gap `pourShrink` times the last, down to `pourMin` s, with `pourJitter` (a fraction) of randomness. While
   *  CRAWLER.max are out, the next waits. */
  crawlersAfter: 6,
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
  private nextA = TIMELINE.punchStart;
  private nextB = TIMELINE.punchStart + TIMELINE.siteBDelay;
  private nextBreak = Infinity;
  private widenLeft = 0;
  private nextWiden = Infinity;
  private open = false;
  private nextCrawler = Infinity;
  private pourGap = TIMELINE.pourFirst;
  phase: Phase = "calm";

  constructor(private stage: Stage) {}

  reset() {
    this.time = 0;
    this.nextA = TIMELINE.punchStart;
    this.nextB = TIMELINE.punchStart + TIMELINE.siteBDelay;
    this.nextBreak = Infinity;
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

  /** The gap after punch n of `total`: irregular, quicker as it goes. */
  private gap(n: number, total: number) {
    if (Math.random() < TIMELINE.doubleChance) return rand(...TIMELINE.doubleGap);
    return rand(...TIMELINE.punchGap) * lerp(1, TIMELINE.escalate, Math.min(1, n / total));
  }

  /** dt: real seconds since the last frame */
  update(dt: number) {
    this.time += dt * this.scale;
    const t = this.time;
    const s = this.stage;
    if (t >= this.nextA && !s.broken) {
      s.punchA();
      if (s.punchesA >= TIMELINE.punchesA) {
        this.nextA = Infinity;
        this.nextBreak = t + rand(...TIMELINE.breakAfter);
      } else this.nextA = t + this.gap(s.punchesA, TIMELINE.punchesA);
    }
    if (t >= this.nextB) {
      s.punchB();
      this.nextB = s.punchesB >= TIMELINE.punchesB ? Infinity : t + this.gap(s.punchesB, TIMELINE.punchesB);
    }
    if (t >= this.nextBreak) {
      this.nextBreak = Infinity;
      if (!s.broken) s.breakThrough();
      this.widenLeft = TIMELINE.widenPunches;
      this.nextWiden = t + rand(...TIMELINE.widenGap);
    }
    if (t >= this.nextWiden) {
      const done = s.widen() || --this.widenLeft <= 0;
      this.nextWiden = done ? Infinity : t + rand(...TIMELINE.widenGap);
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

  /** Break through now, and widen after (the debug panel). */
  breakNow() {
    this.nextA = Infinity;
    this.nextBreak = Infinity;
    this.stage.breakThrough();
    this.widenLeft = TIMELINE.widenPunches;
    this.nextWiden = this.time + rand(...TIMELINE.widenGap);
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
