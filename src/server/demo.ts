// The demo: public workspaces anyone can edit, one per demo room ("demo.<room>", demo-rooms.ts: at most 10 people
// each; "demo" itself is only the alias clients resolve). Each is kept only in memory (a MemoryStore with a size
// budget), seeded with a short tour when the room is made and reset to it every DEMO_RESET_MINUTES (default 15).
// Nobody owns them, so nobody can remove them; their rooms keep no crash log. Bun keeps each room's store in the
// server process (index.ts); Workers keep each room in its own WorkspaceDO (src/workers/demo.ts).
import { config } from "./config.ts";
import { BANNER_WEBP_BASE64 } from "./demo-banner.ts";
import { isDemoRoom } from "./demo-rooms.ts";
import { demoResetPhrase } from "../shared/demo.ts";
import { emit } from "./events.ts";
import type { Ctx } from "./ops.ts";
import type { Db } from "./seams/db.ts";
import { MemoryStore, type MemoryLimits } from "./store/memory.ts";
import type { GitStore } from "./store/types.ts";

export const DEMO_ID = "demo";
export { isDemoRoom };
export const DEMO_FULL = `The demo is full — it resets ${demoResetPhrase(config.demoResetMinutes)}`;

export const demoLimits: MemoryLimits = {
  noteBytes: 1024 * 1024,
  imageBytes: 2 * 1024 * 1024,
  imagesBytes: 10 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  commits: 200,
  fullMessage: DEMO_FULL,
};

export const newDemoStore = () => new MemoryStore(demoLimits);

const WELCOME = `# Welcome to the demo

Grim is a notepad for people and agents. This is a playground: **anyone in it can edit**, live, together (up to 10 people share this copy of the demo). It resets ${demoResetPhrase(config.demoResetMinutes)}, so break things.

![A many-eyed ink creature peers over an open notebook, writing a to-do list, while a little cursor robot sits on the page beside claw scratches](images/banner.webp)

## Agents
Agents edit the same notes as people, through a bash shell over the workspace, and you see their cursor as they write.

### Share with an agent
Signed in, the **Share with an agent** card at the bottom of the sidebar has a **Share** button. Its **Copy prompt** copies a prompt with your link for the open workspace; paste it to your agent (Claude, Codex, …). The link is the agent's way in:

- a GET returns instructions
- each POST runs a shell command (\`ls\`, \`cat\`, \`grep\`, \`echo … >> note.md\`, \`git log\`)

Its edits show up live here, with its own cursor, and are committed like yours.

## Try the Markdown
Type and it renders as you go: **bold**, *italic*, ~~strike~~, ==highlight==, \`inline code\` and [links](https://example.com).

- [x] Open the demo
- [ ] Tick this box
- [ ] Write a heading with \`# \` at the start of a line

| Shortcut | Does |
| --- | --- |
| \`Cmd-B\` | bold |
| \`Cmd-I\` | italic |
| \`Ctrl-P\` | search files |

\`\`\`ts
// fenced code blocks are highlighted
function greet(name: string) {
  return \`Hello, \${name}!\`;
}
\`\`\`

> Every edit is committed to this workspace's history a few seconds after you stop typing. Open **History** to see it.

More in the [tour folder](tour/Markdown%20cheatsheet.md).
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

export const DEMO_SEED: Array<{ path: string; content: string | Uint8Array }> = [
  { path: "Welcome.md", content: WELCOME },
  { path: "tour/Markdown cheatsheet.md", content: CHEATSHEET },
  { path: "tour/Ideas.md", content: IDEAS },
  { path: "images/banner.webp", content: new Uint8Array(Buffer.from(BANNER_WEBP_BASE64, "base64")) },
];

/** A demo room's workspace row (made with the room, deleted when it goes). Nobody owns it, so nobody can remove it. */
export async function createDemoRoomRow(db: Db, id: string) {
  await db.run("INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES (?, 'Demo', 'notes', ?, 'ready', ?) ON CONFLICT (id) DO NOTHING", id, config.defaultBranch, Date.now());
}

/** A demo room's row goes (its agent links and joins with it). */
export async function deleteDemoRoomRow(db: Db, id: string) {
  await db.run("DELETE FROM repos WHERE id = ?", id);
}

/** Rows of demo rooms the lobby doesn't have (left by a restart), and the old shared demo's row: deleted. */
export async function deleteStaleDemoRows(db: Db, live: Set<string>) {
  const rows = await db.all<{ id: string }>("SELECT id FROM repos WHERE id = ? OR id LIKE 'demo.%'", DEMO_ID);
  for (const { id } of rows) if (id === DEMO_ID || (isDemoRoom(id) && !live.has(id))) await deleteDemoRoomRow(db, id);
}

/** A demo room's repo wiped and recreated in `store` with the seed as its only commit. */
export async function seedDemoRepo(store: GitStore, repo: string, branch = config.defaultBranch) {
  await store.deleteRepo(repo);
  await store.createRepo(repo, { branch });
  const res = await store.commit({
    repo,
    branch,
    expectedHead: null,
    changes: DEMO_SEED,
    message: "Start the demo",
    author: { name: "Grim", email: "grimoire@users.noreply.code.storage" },
  });
  if (!res.ok) throw new Error("couldn't seed the demo");
}

/** A room back to the seed: its open rooms are thrown away (clients reconnect and reload), the repo reseeded. */
export async function resetDemo(ctx: Ctx, repo: string) {
  await seedDemoRepo(ctx.store, repo);
  await ctx.rooms.discardRepo(repo);
  emit({ type: "tree", repo });
}

/** Reset every room of the demo (`rooms()`) every `minutes` (DEMO_RESET_MINUTES); returns the stop function. */
export function startDemoResets(ctx: Ctx, rooms: () => string[], minutes = config.demoResetMinutes): () => void {
  if (!(minutes > 0)) return () => {};
  const t = setInterval(() => {
    for (const id of rooms()) void resetDemo(ctx, id).catch((e) => console.error(`[demo] reset ${id} failed:`, e));
  }, minutes * 60_000);
  return () => clearInterval(t);
}
