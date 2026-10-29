// What a bot writes next: a line of its own, the one nobody in the room has written for longest. Two bots may share
// lines (spicy-pretzel and moist-burrito both keep the invasion diary: home-lines.ts), so it goes by everything the
// room's bots wrote: they never write the same line at once, and one doesn't echo what the other just wrote.

/** Of `lines`, one nobody here has written for longest: none of the recent ones, or (all written lately) none of the
 *  last few, and never the last one written (`recent`: everything the room's bots wrote, oldest first). Undefined if
 *  `lines` is empty. */
export function pickLine(lines: string[], recent: string[], rand: () => number = Math.random): string | undefined {
  let fresh = lines;
  for (let n = recent.length; n > 0; n--) {
    const last = recent.slice(-n);
    const f = lines.filter((l) => !last.includes(l));
    if (f.length) {
      fresh = f;
      break;
    }
  }
  return fresh[Math.floor(rand() * fresh.length)];
}
