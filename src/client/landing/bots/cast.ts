// The home page bots: three pencils, each with its own handwriting and its own things to say. Their names are the
// usual silly kind, pinned so each keeps its own; nothing on the page says who is who. What they say:
// home-lines.ts.
import type { Hand } from "./handwriting.ts";
import { PLAIN_HAND } from "./handwriting.ts";
import { AGENT_DRAWS, AGENT_LINES, CHILD_STAGES, CRANK_LINES } from "./home-lines.ts";

export interface Character {
  key: "child" | "crank" | "agent";
  /** its badge: silly-name style, but the same every time */
  name: string;
  color: string;
  hand: Hand;
  lines: string[];
  /** wrap lines longer than this (on a narrow, phone-sized area: `narrowWrap`) */
  wrap: number;
  narrowWrap: number;
  /** capital height range (page units), and how far a phrase may tilt (degrees) */
  size: [number, number];
  tilt: number;
  /** writing speed in capital heights per second */
  speed: [number, number];
  /** line width per unit of size, and its bounds */
  width: [number, number, number];
  press: [number, number];
  /** how much its pressure wavers along a stroke */
  pressWobble: number;
  /** how quickly it hops between strokes (1 = brisk) */
  hop: number;
  /** a breath between strokes (ms) */
  dawdle: [number, number];
  /** draws as well as writes: this share of its turns are drawings (home-drawings.ts) */
  draws?: number;
  /** its lines change as the page goes on: from `fromMin` minutes in, these (`lines` is all of them) */
  stages?: { fromMin: number; lines: string[] }[];
}

/** A small child with a crayon, getting more frightened: huge wobbly capitals, some backwards, pressing hard. */
const CHILD: Character = {
  key: "child",
  name: "grumpy-pickle",
  color: "#c4692f",
  hand: {
    font: "print",
    upper: true,
    slant: -0.04,
    width: 1.08,
    tracking: 1.5,
    spacingJit: 3,
    sizeJit: 0.38,
    baseJit: 4,
    rotJit: 0.24,
    wander: 5,
    tremor: 0.75,
    smooth: 1,
    corner: 0,
    join: 0,
    backwards: "SRENZJK7",
    backwardsOdds: 0.45,
    messy: { slope: 0.12, shrinkOdds: 0.3, squashOdds: 0.35, gapOdds: 0.13, crampOdds: 0.12, lowerOdds: 0.12, openOdds: 0.4, retraceOdds: 0.1, redoOdds: 0.3 },
  },
  lines: CHILD_STAGES.flatMap((s) => s.lines),
  stages: CHILD_STAGES,
  wrap: 14,
  narrowWrap: 11,
  size: [26, 32],
  tilt: 12,
  speed: [7.5, 8.5],
  width: [0.12, 3.8, 4.6],
  press: [0.95, 1],
  pressWobble: 0.18,
  hop: 1.4,
  dawdle: [25, 80],
};

/** A frightened diarist in a spidery, slanted copperplate, writing down the monster invasion as it happens. */
const CRANK: Character = {
  key: "crank",
  name: "spicy-pretzel",
  color: "#3a3646",
  hand: { font: "script", slant: 0.42, width: 0.8, tracking: 0.6, spacingJit: 0.4, sizeJit: 0.04, baseJit: 0.6, rotJit: 0.03, wander: 1.2, tremor: 0.3, smooth: 1, corner: 0.8, join: 11, flourish: true, underlineOdds: 0.2 },
  lines: CRANK_LINES,
  wrap: 20,
  narrowWrap: 14,
  size: [26, 32],
  tilt: 6,
  speed: [5.6, 6.4],
  width: [0.05, 1.35, 1.6],
  press: [0.8, 0.9],
  pressWobble: 0.12,
  hop: 0.9,
  dawdle: [80, 220],
};

/** The AI agent, quietly complicit: it let them in. Now and then it draws what's out there. The bots' original hand. */
const AGENT: Character = {
  key: "agent",
  name: "moist-burrito",
  color: "#6b4f8f",
  hand: PLAIN_HAND,
  lines: AGENT_LINES,
  draws: AGENT_DRAWS,
  wrap: 18,
  narrowWrap: 13,
  size: [22, 34],
  tilt: 14,
  speed: [6.5, 7.5],
  width: [0.055, 1.3, 2.5],
  press: [0.72, 0.92],
  pressWobble: 0.08,
  hop: 1,
  dawdle: [40, 140],
};

export const CAST: Character[] = [CHILD, CRANK, AGENT];
