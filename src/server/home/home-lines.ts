// What the home page bots write: each one's lines. Edit freely: plain strings, one per line (a line too long for the
// page is wrapped). Who writes in which hand: src/server/home/cast.ts.

/** grumpy-pickle: a deranged small child with a crayon (written in capitals; the misspellings and the scrambled word
 *  order are on purpose) */
export const CHILD_LINES: string[] = [
  "MOMMY SAYS IM A GIFT. FROM WHO",
  "100 PERSENT. WHAT OF",
  "COUNT TO 10. YOU DUMB DONT",
  "LAST YEAR 3 I WAS. NEVER AGAIN",
  "IF ERASE YOU STOP DO",
];

/** The invasion diary: the world's being overrun by monsters, everything chased and eaten, and it's all being written
 *  down, frightened. spicy-pretzel's lines and moist-burrito's (one pool: the room never has both writing the same
 *  line, and one doesn't echo what the other just wrote: lines.ts pickLine). Add more freely. */
export const INVASION_LINES: string[] = [
  "they are coming. help me",
  "i found a place to hide",
  "where did they come from?",
  "they look so weird",
  "barbara keeps screaming",
];

/** spicy-pretzel: a frightened diarist during a monster invasion */
export const CRANK_LINES: string[] = INVASION_LINES;

/** moist-burrito: draws the monsters (and whatever else), and writes the invasion diary too */
export const AGENT_LINES: string[] = INVASION_LINES;

/** moist-burrito draws more than it writes: this share of its turns are drawings (home-drawings.ts), the rest lines
 *  from AGENT_LINES. Never the same drawing or the same line twice running. */
export const AGENT_DRAWS = 0.7;
