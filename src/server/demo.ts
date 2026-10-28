// The demo folder: a public folder with id "demo" that anyone can edit, kept only in memory (a MemoryStore behind
// the RoutedStore) with a size budget, seeded with a short tour at startup and reset to that seed every
// DEMO_RESET_HOURS. Nobody owns it, so nobody can remove it; its rooms keep no crash log.
import { config } from "./config.ts";
import { db } from "./db.ts";
import { emit } from "./events.ts";
import type { Ctx } from "./ops.ts";
import { getRepo } from "./repos.ts";
import { MemoryStore, type MemoryLimits } from "./store/memory.ts";

export const DEMO_ID = "demo";
export const DEMO_FULL = "The demo is full — it resets every few hours";

export const demoLimits: MemoryLimits = {
  noteBytes: 1024 * 1024,
  imageBytes: 2 * 1024 * 1024,
  imagesBytes: 10 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  commits: 200,
  fullMessage: DEMO_FULL,
};

export const newDemoStore = () => new MemoryStore(demoLimits);

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="120" viewBox="0 0 360 120">
  <rect width="360" height="120" rx="14" fill="#18181b"/>
  <text x="180" y="72" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="40" font-weight="700" letter-spacing="6" fill="#fafafa">GRIMOIRE</text>
  <text x="180" y="98" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="13" fill="#a1a1aa">a notepad for people and agents</text>
</svg>
`;

const WELCOME = `# Welcome to the demo

This folder is a playground: **anyone can edit it**, live, together. It resets every few hours, so break things.

![Grimoire](images/grimoire.svg)

## Try the Markdown
Type and it renders as you go: **bold**, *italic*, ~~strike~~, ==highlight==, \`inline code\` and [links](https://example.com).

- [x] Open the demo
- [ ] Tick this box
- [ ] Write a heading with \`# \` at the start of a line

| Shortcut | Does |
| --- | --- |
| \`Cmd-B\` | bold |
| \`Cmd-I\` | italic |
| \`/\` | filter files |

\`\`\`ts
// fenced code blocks are highlighted
function greet(name: string) {
  return \`Hello, \${name}!\`;
}
\`\`\`

> Every edit is committed to this folder's history a few seconds after you stop typing. Open **History** to see it.

More in [Agents](Agents.md) and the [tour folder](tour/Markdown%20cheatsheet.md).
`;

const AGENTS = `# Agents

Agents edit the same notes as people, through a bash shell over the folder, and you see their cursor as they write.

## Share with an agent
Signed in, the **Share with an agent** card at the bottom of the sidebar has a **Copy** button. It copies a prompt with your link for the open folder; paste it to your agent (Claude, Codex, …). The link is the agent's way in:

- a GET returns instructions
- each POST runs a shell command (\`ls\`, \`cat\`, \`grep\`, \`echo … >> note.md\`, \`git log\`)

Its edits show up live here, with its own cursor, and are committed like yours.
`;

const CHEATSHEET = `# Markdown cheatsheet

## Headings
\`# Title\`, \`## Section\`, \`### Subsection\`

## Lists
- bullets with \`- \`
1. numbers with \`1. \`
- [ ] todos with \`- [ ] \`

## Quotes and rules
> a quote

---
`;

const IDEAS = `# Ideas

- A shared shopping list
- Meeting notes, written together
- A plan an agent keeps up to date
`;

export const DEMO_SEED: Array<{ path: string; content: string }> = [
  { path: "Welcome.md", content: WELCOME },
  { path: "Agents.md", content: AGENTS },
  { path: "tour/Markdown cheatsheet.md", content: CHEATSHEET },
  { path: "tour/Ideas.md", content: IDEAS },
  { path: "images/grimoire.svg", content: LOGO },
];

/** Put the demo's seed in (a fresh repo in its store), and its folder row if it's missing. */
export async function seedDemo(ctx: Ctx) {
  const branch = config.defaultBranch;
  if (!getRepo(DEMO_ID)) {
    // Nobody owns it (so nobody can remove it); public like every folder.
    db.query("INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES (?, 'Demo', 'notes', ?, 'ready', ?)").run(DEMO_ID, branch, Date.now());
  }
  await ctx.store.deleteRepo(DEMO_ID);
  await ctx.store.createRepo(DEMO_ID, { branch });
  const res = await ctx.store.commit({
    repo: DEMO_ID,
    branch: getRepo(DEMO_ID)!.branch,
    expectedHead: null,
    changes: DEMO_SEED,
    message: "Start the demo",
    author: { name: "Grimoire", email: "grimoire@users.noreply.code.storage" },
  });
  if (!res.ok) throw new Error("couldn't seed the demo");
}

/** Back to the seed: open rooms are thrown away (their clients reconnect and reload), the repo is wiped and reseeded. */
export async function resetDemo(ctx: Ctx) {
  await seedDemo(ctx);
  await ctx.rooms.discardRepo(DEMO_ID);
  emit({ type: "tree", repo: DEMO_ID });
}

/** Reset the demo every `hours` (DEMO_RESET_HOURS); returns the stop function. */
export function startDemoResets(ctx: Ctx, hours = config.demoResetHours): () => void {
  if (!(hours > 0)) return () => {};
  const t = setInterval(() => void resetDemo(ctx).catch((e) => console.error("[demo] reset failed:", e)), hours * 3600_000);
  return () => clearInterval(t);
}
