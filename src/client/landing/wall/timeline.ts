// The director: what happens when, counted from page load. Every timing is here. It only decides; the wall
// (index.ts) carries out each step with the pieces. With ?wall=debug, a panel to fire each step by hand, speed the
// clock up and see the phase. (The clock scale speeds up the schedule, not the animations: a strike still takes a
// strike's time, so a sped-up run shows the sequence with each piece looking as it will.)
import { rand } from "./core.ts";

export const TIMELINE = {
  /** seconds from load */
  firstStrike: 17,
  /** between strikes (s): before cracking, while cracking, and once there's a hole */
  strikeEvery: [5, 10] as const,
  strikeEveryCracking: [4, 8] as const,
  strikeEveryOpen: [6, 14] as const,
  /** cracking starts after this many strikes, then grows a crack this often (s) */
  crackAfter: 6,
  crackEvery: [2, 5] as const,
  /** the first piece falls, then more this often (s) */
  firstBreak: 90,
  breakEvery: [7, 14] as const,
  /** the big break: when (s), and how many pieces go (one every `holeGap` s, real time) */
  holeAt: 160,
  holePieces: 24,
  holePiecesLow: 12,
  holeGap: 0.22,
  /** after the hole, it keeps growing a piece at a time this often (s) */
  growEvery: [12, 25] as const,
  /** crawlers: the first (s), then the stream: the next after `pourFirst` s, each gap `pourShrink` times the last, down
   *  to `pourMin` s, with `pourJitter` (a fraction) of randomness. While CRAWLER.max are out, the next waits. */
  crawlersFrom: 190,
  pourFirst: 6,
  pourShrink: 0.8,
  pourMin: 0.7,
  pourJitter: 0.3,
};

/** What the director can make happen. */
export interface Stage {
  strike(): void;
  crack(): void;
  breakPiece(): void;
  openHole(): void;
  /** false if none could come out (too many out already) */
  spawnCrawler(): boolean;
  reset(): void;
  readonly strikes: number;
  readonly pieces: number;
  readonly crawlers: number;
}

type Phase = "calm" | "strikes" | "cracking" | "breaking" | "hole" | "crawlers";

export class Director {
  time = 0;
  scale = 1;
  private nextStrike = TIMELINE.firstStrike;
  private nextCrack = Infinity;
  private nextBreak = TIMELINE.firstBreak;
  private holeDone = false;
  private nextGrow = Infinity;
  private nextCrawler = TIMELINE.crawlersFrom;
  private pourGap = TIMELINE.pourFirst;
  phase: Phase = "calm";

  constructor(private stage: Stage) {}

  reset() {
    this.time = 0;
    this.nextStrike = TIMELINE.firstStrike;
    this.nextCrack = Infinity;
    this.nextBreak = TIMELINE.firstBreak;
    this.holeDone = false;
    this.nextGrow = Infinity;
    this.nextCrawler = TIMELINE.crawlersFrom;
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
    if (t >= this.nextStrike) {
      s.strike();
      const every = this.holeDone ? TIMELINE.strikeEveryOpen : this.nextCrack < Infinity ? TIMELINE.strikeEveryCracking : TIMELINE.strikeEvery;
      this.nextStrike = t + rand(every[0], every[1]);
      if (this.nextCrack === Infinity && s.strikes >= TIMELINE.crackAfter) this.nextCrack = t + 1;
    }
    if (t >= this.nextCrack) {
      s.crack();
      this.nextCrack = t + rand(...TIMELINE.crackEvery);
    }
    if (!this.holeDone && t >= this.nextBreak) {
      s.breakPiece();
      this.nextBreak = t + rand(...TIMELINE.breakEvery);
    }
    if (!this.holeDone && t >= TIMELINE.holeAt) {
      this.holeDone = true;
      s.openHole();
      this.nextGrow = t + rand(...TIMELINE.growEvery);
    }
    if (t >= this.nextGrow) {
      s.breakPiece();
      this.nextGrow = t + rand(...TIMELINE.growEvery);
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
      : this.holeDone ? "hole"
      : s.pieces > 0 ? "breaking"
      : this.nextCrack < Infinity ? "cracking"
      : s.strikes > 0 ? "strikes"
      : "calm";
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
  btn("Strike", () => stage.strike());
  btn("Crack", () => stage.crack());
  btn("Break piece", () => stage.breakPiece());
  btn("Open hole", () => stage.openHole());
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
    const text = `${m}:${sec} · ${director.phase} · hits ${stage.strikes} · pieces ${stage.pieces} · crawlers ${stage.crawlers} live`;
    if (text !== last) readout.textContent = last = text;
  };
  return { el, tick };
}
