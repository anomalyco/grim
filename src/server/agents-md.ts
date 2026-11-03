// A workspace's AGENTS.md: the rules for working in it, which every agent is shown. Like OpenCode, only a file named
// exactly AGENTS.md counts (case-sensitive), and only at the workspace's root (work/agents.md is just a note). Agents
// get the text as last committed (not every keystroke of someone typing it), cut at MAX_AGENTS_MD_BYTES:
// - GET of the workspace URL: always, at the end of the instructions (agent-url.ts);
// - POST and MCP `command` / `changes`: once per agent session, and once more whenever the file changes. Each workspace
//   remembers which session saw which version (its runtime's SeenStore: in memory on Bun, the WorkspaceDO's SQLite).
// The same store remembers which version of each note's instructions block (shared/instructions.ts) a session read:
// agents' writes are refused until they've read the latest of both (instructions.ts).

import { AGENTS_MD } from "../shared/agents-md.ts";
export { AGENTS_MD };
export const MAX_AGENTS_MD_BYTES = 8 * 1024;
export const AGENTS_MD_TRUNCATED = "(truncated; read AGENTS.md for the rest)";
/** How long a session counts as having seen a version, and how many (session, file) pairs a workspace remembers. */
export const SEEN_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_SEEN = 20000;

/** The workspace's AGENTS.md, ready to show: `version` is the hash of the whole file. */
export interface AgentsMd {
  text: string;
  version: string;
  truncated: boolean;
}

/**
 * What `agentsMd` answers for a session: the file (null: none), and whether this session hadn't seen this version.
 * `stale`: it had seen an older one (with `onlyNew`, that isn't marked seen yet: the caller marks it after the command).
 */
export interface AgentsMdFor {
  file: AgentsMd | null;
  unseen: boolean;
  stale?: boolean;
}

/** The text as shown: whole, or cut on a line (or character) boundary to fit the cap, with a note to read the rest. */
export function capAgentsMd(content: string, version: string): AgentsMd {
  const text = content.replace(/\s+$/, "");
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= MAX_AGENTS_MD_BYTES) return { text, version, truncated: false };
  const room = MAX_AGENTS_MD_BYTES - AGENTS_MD_TRUNCATED.length - 2;
  let cut = new TextDecoder().decode(bytes.slice(0, room)).replace(/\uFFFD$/, "");
  const nl = cut.lastIndexOf("\n");
  if (nl > room / 2) cut = cut.slice(0, nl);
  return { text: `${cut.replace(/\s+$/, "")}\n\n${AGENTS_MD_TRUNCATED}`, version, truncated: true };
}

/** The block prepended to a command's output the first time a session sees this version. */
export function agentsMdBlock(file: AgentsMd): string {
  return `[Workspace instructions (AGENTS.md), shown once per session and again if it changes]\n${file.text}\n[end of AGENTS.md]\n\n`;
}

/**
 * Which session keys saw which version of which file, in one workspace: AGENTS.md (path AGENTS_MD, the version of
 * the whole file) and notes' instructions blocks (the block's version). `path` defaults to AGENTS.md.
 */
export interface SeenStore {
  get(session: string, path?: string): string | null;
  put(session: string, version: string, path?: string): void;
}

/** A SeenStore in memory (Bun; tests): entries expire after SEEN_TTL_MS, and the oldest go past MAX_SEEN. */
export function memorySeenStore(now = () => Date.now()): SeenStore {
  const seen = new Map<string, { version: string; at: number }>();
  const k = (session: string, path = AGENTS_MD) => `${session}\0${path}`;
  return {
    get(session, path) {
      const s = seen.get(k(session, path));
      if (!s) return null;
      if (now() - s.at > SEEN_TTL_MS) {
        seen.delete(k(session, path));
        return null;
      }
      return s.version;
    },
    put(session, version, path) {
      seen.delete(k(session, path));
      seen.set(k(session, path), { version, at: now() });
      for (const k of seen.keys()) {
        if (seen.size <= MAX_SEEN) break;
        seen.delete(k);
      }
    },
  };
}

/** The key "seen" is remembered under for a workspace-URL call: its session_id, else its account or address plus its name. */
export function urlSessionKey(o: { sessionId?: string; userId: string | null; ip: string; name: string }): string {
  if (o.sessionId) return `s:${o.sessionId}`;
  return o.userId ? `u:${o.userId}:${o.name.toLowerCase()}` : `ip:${o.ip}:${o.name.toLowerCase()}`;
}

/** The key for an MCP call: its session_id, else its MCP connection (Mcp-Session-Id). */
export function mcpSessionKey(o: { sessionId?: string; userId: string; connection: string }): string {
  return o.sessionId ? `s:${o.sessionId}` : `mcp:${o.userId}:${o.connection}`;
}
