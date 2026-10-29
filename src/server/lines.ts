// What a bot writes next: mostly a random line of its own, but some lines answer another bot's line ("prompts" and
// "responses"). A response can only come after its prompt has been written, recently, by another bot, and only once;
// when one can, it's likely to be next, so the exchange reads as one.
import type { Box } from "../shared/handwriting.ts";

export interface Line {
  text: string;
  /** a prompt: other bots have lines answering it */
  id?: string;
  /** a response: answers the prompt with this id */
  respondsTo?: string;
}

/** a response must follow its prompt within this long (while the prompt is still plausibly on the page) */
export const RESPONSE_WINDOW_MS = 150_000;
/** how likely a bot is to pick a response it could write, rather than a line of its own */
export const RESPONSE_ODDS = 0.9;

/** The prompts written so far: who finished each, when, and where (the response goes near it). */
export class PromptBoard {
  private written = new Map<string, { by: string; t: number; box?: Box; answered: boolean }>();

  /** `by` has finished writing `line` (a prompt arms its responses, again if it's written again). */
  wrote(line: Line, by: string, t: number, box?: Box) {
    if (line.id) this.written.set(line.id, { by, t, box, answered: false });
  }

  /** Can `who` write this response now? */
  open(line: Line, who: string, now: number): boolean {
    if (!line.respondsTo) return false;
    const p = this.written.get(line.respondsTo);
    return !!p && !p.answered && p.by !== who && now - p.t <= RESPONSE_WINDOW_MS;
  }

  /** Where the prompt a response answers was written. */
  boxOf(line: Line): Box | undefined {
    return line.respondsTo ? this.written.get(line.respondsTo)?.box : undefined;
  }

  answer(line: Line) {
    const p = line.respondsTo ? this.written.get(line.respondsTo) : undefined;
    if (p) p.answered = true;
  }
}

/** The next line for `who`: a response it can write (likely, when there is one), else a line of its own that it hasn't
 *  written lately (prompts a little more often). Responses that can't be written yet are never picked. */
export function pickLine(lines: Line[], who: string, board: PromptBoard, now: number, recent: string[], rand: () => number = Math.random): Line {
  const responses = lines.filter((l) => board.open(l, who, now));
  if (responses.length && rand() < RESPONSE_ODDS) {
    const l = responses[Math.floor(rand() * responses.length)]!;
    board.answer(l);
    return l;
  }
  const own = lines.filter((l) => !l.respondsTo);
  const fresh = own.filter((l) => !recent.includes(l.text));
  // (prompts count twice, so an exchange comes up every few minutes)
  const pool = (fresh.length ? fresh : own).flatMap((l) => (l.id ? [l, l] : [l]));
  return pool[Math.floor(rand() * pool.length)]!;
}
