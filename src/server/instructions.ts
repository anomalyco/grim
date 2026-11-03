// "Read the latest instructions before writing": an agent session's writes are refused until it has read the
// workspace's current AGENTS.md (agents-md.ts) and, for a note it changes, the note's current instructions block
// (shared/instructions.ts). The runtime keeps who read what in its SeenStore, keyed by session (agents-md.ts
// urlSessionKey / mcpSessionKey) and path; people (the browser, the Mac app) are never checked.
// - Reads: the shell's `instructions [note…]` prints just the blocks (no argument: AGENTS.md) and marks them read;
//   besides, the shell marks every note it read in a command (any read: cat, grep, head, sed -n…; even one that
//   doesn't show the block) once the command is done, so a write in the same command doesn't count it; a note GET
//   and the AGENTS.md delivered with a command or workspace_info mark it at once. A session's own successful write
//   marks what it wrote.
// - Writes: editing or deleting a note needs AGENTS.md and the note's block; creating one needs AGENTS.md; a rename
//   is both (the source's block, AGENTS.md for the target).
// - Versions: a note's block as a read would show it now (its live text, unsaved edits included, so a block someone
//   just edited applies at once); AGENTS.md as committed or as live (it's delivered as committed).
import { AGENTS_MD } from "./agents-md.ts";
import { OpError, version } from "./ops.ts";
import { instructionsOf } from "../shared/instructions.ts";

/** HTTP-ish status of a refused write (Precondition Required). */
export const UNREAD_STATUS = 428;

/** The version of a note's instructions block (null: it has none). */
export function blockVersion(text: string): string | null {
  const body = instructionsOf(text);
  return body === null ? null : version(body);
}

/** What a session's read of `path` (its text as read) marks: the block's version (AGENTS.md: the file's), or null. */
export function readVersion(path: string, text: string): string | null {
  return path === AGENTS_MD ? version(text) : blockVersion(text);
}

export function unreadNote(path: string): OpError {
  return new OpError(UNREAD_STATUS, `${path} has instructions you haven't read (or they changed since you read it). Run: instructions ${path} — then redo your edit.`);
}

export function unreadAgentsMd(changed: boolean): OpError {
  return new OpError(
    UNREAD_STATUS,
    changed
      ? `This workspace's ${AGENTS_MD} changed since you read it. Run: instructions — then redo your command.`
      : `You haven't read this workspace's ${AGENTS_MD}. Run: instructions — then redo your command.`,
  );
}

/** One line for agents' instructions (the workspace URL's GET, MCP `command`). */
export const INSTRUCTIONS_RULE =
  "Notes may start with an ```instructions block, and the workspace may have an AGENTS.md. Writes are refused until you've read the latest version of both (for the note you're editing): run `instructions <note>` (just its block; `instructions` alone: AGENTS.md), or read the file any other way, then retry. Reads count from the next call, so send the same session_id on every call.";
