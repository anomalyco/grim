// How often the demo workspace resets, in words (DEMO_RESET_MINUTES; the client gets it from POST /api/demo/room).

/** "every 15 minutes", "every 6 hours", "on restart" (0); `undefined` (a server that doesn't say): "every few hours". */
export function demoResetPhrase(minutes: number | undefined): string {
  if (minutes === undefined || !Number.isFinite(minutes)) return "every few hours";
  if (!(minutes > 0)) return "on restart";
  const unit = (n: number, word: string) => (n === 1 ? `every ${word}` : `every ${n} ${word}s`);
  return minutes % 60 === 0 ? unit(minutes / 60, "hour") : unit(minutes, "minute");
}
