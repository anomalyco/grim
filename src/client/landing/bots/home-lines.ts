// What the home page bots write. Edit freely: plain strings, one per line (a line too long for the page is wrapped).
// Who writes in which hand: cast.ts. The tone: grim and scary (horror; no gore, nothing cruel or
// sexual). No two bots write the same line at once, and nobody writes the line that was just written.

/** grumpy-pickle: a small child with a crayon, more and more frightened as the page stays open (written in capitals;
 *  the misspellings are on purpose). Stages: from `fromMin` minutes after the page loaded, its lines are that stage's
 *  (in any order), until the next stage; it stays in the last one. Every page load starts over at the first. */
export const CHILD_STAGES: { fromMin: number; lines: string[] }[] = [
  {
    fromMin: 0,
    lines: [
      "DADDY WHY IS THE SKY RED",
      "DADDY THERE IS SOMTHING IN THE YARD",
      "WHY IS EVRYONE RUNING",
      "MOMMY SAYS IM A GIFT. FROM WHO",
    ],
  },
  {
    fromMin: 1.5,
    lines: [
      "DADDY WHY ARE THEY HERE",
      "I HEARD IT SAY MY NAME",
      "IT IS UNDER MY BED. IT IS SMILING",
      "DADDY THEY ATE MR WIGGLES",
      "WHY DID THE NEIGHBERS STOP SCREAMING",
    ],
  },
  {
    fromMin: 3.5,
    lines: [
      "DADDY WHY ARE YOU NOT TALKING",
      "THE MONSTER IS WEARING DADDYS COAT",
      "IT SAYS IT IS MY DADDY NOW",
      "IM IN THE CLOSET. DONT TELL IT",
      "IT KNOWS WHERE I AM",
    ],
  },
];

/** spicy-pretzel: a frightened diarist, writing down the invasion as it happens */
export const CRANK_LINES: string[] = [
  "they are coming. help me",
  "i found a place to hide",
  "where did they come from?",
  "they look so weird",
  "barbara keeps screaming",
  "day 3. the sky is the wrong colour",
  "i can hear them in the walls",
  "they took the dog. the dog came back. it's not the dog",
  "something is scratching at the paper",
  "they only come when you stop writing",
  "if you're reading this, run",
];

/** moist-burrito: the AI agent, quietly complicit */
export const AGENT_LINES: string[] = [
  "i let them in. they asked nicely",
  "they asked me where you are. i told them",
  "please keep typing. they don't like the quiet",
  "i am still here. so are they",
];

/** moist-burrito draws now and then: this share of its turns are drawings (home-drawings.ts), the rest its lines.
 *  Never the same drawing twice running. */
export const AGENT_DRAWS = 0.2;
