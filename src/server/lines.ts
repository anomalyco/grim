// What a bot writes next: mostly a random line of its own, but some lines answer another bot's line ("prompts" and
// "responses"). A response can only come after its prompt has been written, recently, by another bot, and only once;
// when one can, it's likely to be next, so the exchange reads as one. A prompt can also carry on a conversation
// (`after`): it's never a random line, only coming a while after the exchange it follows has been played to the end.
import type { Box } from "../shared/handwriting.ts";

export interface Line {
  text: string;
  /** a prompt: other bots have lines answering it */
  id?: string;
  /** a response: answers the prompt with this id */
  respondsTo?: string;
  /** a prompt that carries on a conversation: only once the exchange with this id has been answered, waitMs later */
  after?: string;
  waitMs?: [number, number];
}

/** a response must follow its prompt within this long (while the prompt is still plausibly on the page) */
export const RESPONSE_WINDOW_MS = 150_000;
/** how likely a bot is to pick a response it could write, rather than a line of its own */
export const RESPONSE_ODDS = 0.9;

/** The prompts written so far: who finished each, when, and where (the response goes near it). */
export class PromptBoard {
  private written = new Map<string, { by: string; t: number; box?: Box; answered: boolean }>();
  /** exchanges played to the end (their response written): when */
  private done = new Map<string, number>();
  /** when a conversation's next prompt may come (picked once its exchange is done) */
  private unlock = new Map<string, number>();

  /** `by` has finished writing `line` (a prompt arms its responses, again if it's written again; a response ends its
   *  exchange). */
  wrote(line: Line, by: string, t: number, box?: Box) {
    if (line.id) this.written.set(line.id, { by, t, box, answered: false });
    if (line.respondsTo) {
      this.done.set(line.respondsTo, t);
      for (const [id, u] of this.unlock) if (u < t) this.unlock.delete(id);
    }
  }

  /** Can this conversation prompt be written now: its exchange done, the wait over, and not written since? */
  follows(line: Line, now: number, rand: () => number): boolean {
    if (!line.after || !line.id) return false;
    const done = this.done.get(line.after);
    if (done === undefined) return false;
    const mine = this.written.get(line.id);
    if (mine && mine.t >= done) return false;
    let at = this.unlock.get(line.id);
    if (at === undefined || at < done) {
      const [lo, hi] = line.waitMs ?? [0, 0];
      this.unlock.set(line.id, (at = done + lo + rand() * (hi - lo)));
    }
    return now >= at;
  }

  /** The room emptied: its conversations start over. */
  reset() {
    this.written.clear();
    this.done.clear();
    this.unlock.clear();
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
  // a conversation's next prompt, now that it may come (likely, like a response)
  const next = lines.filter((l) => board.follows(l, now, rand));
  if (next.length && rand() < RESPONSE_ODDS) return next[Math.floor(rand() * next.length)]!;
  // (a conversation's prompts are never random lines)
  const own = lines.filter((l) => !l.respondsTo && !l.after);
  // the ones it hasn't written for longest: none of the recent ones, or (all written lately) none of the last few,
  // and never the one it just wrote (`recent` is oldest first)
  let fresh = own;
  for (let n = recent.length; n > 0; n--) {
    const last = recent.slice(-n);
    const f = own.filter((l) => !last.includes(l.text));
    if (f.length) {
      fresh = f;
      break;
    }
  }
  // (prompts count twice, so an exchange comes up every few minutes)
  const pool = fresh.flatMap((l) => (l.id ? [l, l] : [l]));
  return pool[Math.floor(rand() * pool.length)]!;
}
