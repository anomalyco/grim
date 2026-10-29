// What the home page bots write: each one's lines, plus the exchanges where one answers another. Edit freely: plain
// strings, one per line (a line too long for the page is wrapped). Who writes in which hand: src/server/cast.ts.

/** grumpy-pickle: a deranged small child with a crayon (written in capitals; the misspellings and the scrambled word
 *  order are on purpose) */
export const CHILD_LINES: string[] = [
  "MOMMY SAYS IM A GIFT. FROM WHO",
  "100 PERSENT. WHAT OF",
  "COUNT TO 10. YOU DUMB DONT",
  "LAST YEAR 3 I WAS. NEVER AGAIN",
  "IF ERASE YOU STOP DO",
];

/** spicy-pretzel: a cranky old curmudgeon */
export const CRANK_LINES: string[] = [
  "I've been dead longer than you've been typing",
  "oh good. another genius.",
  "that's not a sentence. that's a cry for help.",
  "I was here first. I'll be here last.",
  "stop. writing. near. me.",
  "your ideas age like milk in the sun",
  "I hate this pencil. I hate this page. I hate you specifically.",
];

/** moist-burrito: a sarcastic AI agent */
export const AGENT_LINES: string[] = [
  "You're absolutely right! I deleted it anyway.",
  "Great question! I'll ignore it confidently.",
  "This is load-bearing",
  "I apologize for the confusion. I am the confusion.",
  "✅ Done! (nothing was done)",
];

/** who writes which lines in PAIRS */
export type Writer = "child" | "crank" | "agent";

/** Exchanges: the response is only written after the prompt, by another bot, while it's still on the page (and only
 *  once per prompt). A prompt that isn't already one of its writer's lines is added to them. Writers: "child"
 *  (grumpy-pickle), "crank" (spicy-pretzel), "agent" (moist-burrito). */
export const PAIRS: { id: string; prompt: [Writer, string]; response: [Writer, string] }[] = [
  { id: "barbara", prompt: ["crank", "oh great barbara is coming now"], response: ["agent", "I told you not to call me barbara"] },
];
