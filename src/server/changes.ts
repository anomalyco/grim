// `changes`: what people wrote by hand since the last agent commit in a workspace (the agent link's shell built-in,
// GET /a/<id>/changes, MCP's `changes` tool). Agent commits are the ones whose author email is an agent's
// (`@agents.grimoire`, auth.ts participantForAgent); since agents' writes are committed on their own commits right
// after each command (Room.commitPinned), everything after the newest one is people's: their commits, then their
// unsaved live edits.
import { structuredPatch } from "diff";
import { unified } from "./store/unified.ts";

/** Commits by an agent (agent link or MCP) carry this author email domain. */
export const AGENT_EMAIL = /@agents\.grimoire$/i;

/** The most text the diffs may total (the shell's output cap): the rest is listed without its diff. */
export const MAX_CHANGES_BYTES = 200 * 1024;
/** Commits looked back through for the newest agent commit. */
export const CHANGES_HISTORY = 300;

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** a renamed file's old path */
  from?: string;
  added: number;
  removed: number;
  /** unified diff ("" when it didn't fit: `truncated`) */
  diff: string;
}

export interface ChangesResult {
  /** the newest agent commit (null: none yet, so every change since the first commit is listed) */
  since: { commit: string; agent: string; at: string } | null;
  files: ChangedFile[];
  truncated: boolean;
}

/** Line counts and the unified diff of one file. */
export function fileDiff(path: string, before: string | null, after: string | null, from?: string): Omit<ChangedFile, "status"> {
  const p = structuredPatch("a", "b", before ?? "", after ?? "", "", "", { context: 3 });
  let added = 0;
  let removed = 0;
  for (const h of p.hunks) for (const l of h.lines) l[0] === "+" ? added++ : l[0] === "-" ? removed++ : 0;
  let diff = unified(path, before, after);
  if (from) diff = `rename from ${from}\nrename to ${path}\n` + (before === after ? "" : diff);
  return { path, ...(from ? { from } : {}), added, removed, diff };
}

/** "5 minutes ago" and the like. */
export function ago(at: string | number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(at).getTime()) / 1000));
  const unit = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"} ago`;
  if (s < 45) return "just now";
  if (s < 3600) return unit(Math.max(1, Math.round(s / 60)), "minute");
  if (s < 86_400) return unit(Math.round(s / 3600), "hour");
  if (s < 30 * 86_400) return unit(Math.round(s / 86_400), "day");
  return new Date(at).toISOString().slice(0, 10);
}

const LETTER: Record<ChangedFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

/** The text the shell and MCP show: a header, the files with status and +/− counts, then (unless `stat`) the diffs. */
export function formatChanges(r: ChangesResult, opts: { stat?: boolean; path?: string } = {}): string {
  const scope = opts.path ? ` in ${opts.path}` : "";
  const head = r.since
    ? `Manual changes${scope} since the last agent commit ${r.since.commit.slice(0, 7)} (${r.since.agent}, ${ago(r.since.at)}):`
    : `No agent commit yet; showing all manual changes${scope}:`;
  if (!r.files.length) return `${head}\n(none)\n`;
  const w = Math.max(...r.files.map((f) => (f.from ? `${f.from} -> ${f.path}` : f.path).length));
  let out = `${head}\n`;
  for (const f of r.files) out += `${LETTER[f.status]} ${(f.from ? `${f.from} -> ${f.path}` : f.path).padEnd(w)}  +${f.added} -${f.removed}\n`;
  if (!opts.stat) {
    const diffs = r.files.map((f) => f.diff).filter(Boolean);
    if (diffs.length) out += `\n${diffs.join("")}`;
  }
  if (r.truncated) out += `\n[truncated: the diffs are over ${MAX_CHANGES_BYTES / 1024} KB; narrow it with \`changes <path>\` or use --stat]\n`;
  return out;
}

/** Changed paths named by unified diffs (`diff --git a/X b/Y` headers; both sides). */
export function diffPaths(diff: string): string[] {
  const out = new Set<string>();
  for (const m of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    out.add(m[1]!);
    out.add(m[2]!);
  }
  for (const m of diff.matchAll(/^(?:---|\+\+\+) [ab]\/(.+)$/gm)) out.add(m[1]!);
  return [...out];
}
