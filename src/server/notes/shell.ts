// The agent shell over one note (docs/storage-v2.md §8): a fresh just-bash interpreter per command whose whole
// filesystem is an in-memory tree with the note as ./<name> in /note (plus just-bash's virtual /bin, /dev, /proc).
// No other notes, no workspace tree, nothing kept between commands. The caller applies what the command wrote to
// the note as a 3-way patch into the live room (workspace.ts agentCommand).
import { trusted } from "./trust.ts";
import { Bash, defineCommand, getCommandNames, InMemoryFs, type CommandName, type ExecResult } from "just-bash";

export const NOTE_DIR = "/note";
/** Default and longest time per command. */
export const DEFAULT_TIMEOUT_S = 30;
export const MAX_TIMEOUT_S = 110;
/** stdout and stderr are each cut here. */
export const MAX_OUTPUT_BYTES = 200 * 1024;
const SCRATCH_BYTES = 16 * 1024 * 1024;
const EXCLUDED = new Set<string>(["sqlite3", "html-to-markdown"]);

export interface HistoryEntry {
  id: string;
  date: string;
  author: string;
  kind: string;
  message: string;
}

/** What the built-ins read from the note's workspace. */
export interface NoteShellHost {
  history(limit: number): HistoryEntry[];
  /** A version's text, or null. */
  show(id: string): string | null;
  /** A version as a unified diff against the one before it, or null. */
  diff(id: string): string | null;
  who(): Array<{ name: string; kind: string }>;
}

export interface NoteShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  /** The note's text after the command (undefined: unchanged; null: the command deleted it). */
  wrote?: string | null;
}

export function parseTimeout(v: unknown): number | string {
  if (v === undefined || v === null) return DEFAULT_TIMEOUT_S;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > MAX_TIMEOUT_S) return `timeout_seconds must be a number from 1 to ${MAX_TIMEOUT_S}`;
  return v;
}

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string, exitCode = 1): ExecResult => ({ stdout: "", stderr, exitCode });

const HISTORY_USAGE = "usage: history [N] | history show <id> | history diff <id>\n";

function builtins(host: NoteShellHost, user: string) {
  return [
    defineCommand("history", async (args) => {
      const [sub, arg] = args;
      if (sub === "show" || sub === "diff") {
        if (!arg) return fail(HISTORY_USAGE, 2);
        const out = sub === "show" ? trusted(() => host.show(arg)) : trusted(() => host.diff(arg));
        return out === null ? fail(`history: no version ${arg} of this note\n`) : ok(out);
      }
      if (sub === "-h" || sub === "--help") return ok(HISTORY_USAGE);
      const n = sub === undefined ? 20 : Number(sub.replace(/^-n/, "").replace(/^-/, ""));
      if (!Number.isInteger(n) || n < 1) return fail(HISTORY_USAGE, 2);
      const rows = trusted(() => host.history(Math.min(n, 200)));
      if (!rows.length) return ok("(no versions yet: edits become a version after 5 minutes without changes, or right after an agent's command)\n");
      return ok(rows.map((r) => `${r.id}  ${r.date}  ${r.kind.padEnd(7)}  ${r.author}${r.message ? `  ${r.message}` : ""}`).join("\n") + "\n");
    }),
    defineCommand("who", async () => {
      const people = trusted(() => host.who());
      return ok(people.length ? people.map((p) => `${p.name} (${p.kind})`).join("\n") + "\n" : "(nobody has this note open)\n");
    }),
    defineCommand("whoami", async () => ok(`${user}\n`)),
    ...["git", "python", "python3", "node", "curl", "wget", "vi", "vim", "nano", "ssh"].map((name) =>
      defineCommand(name, async () => fail(`${name}: not available. This shell sees one note; use history for its versions.\n`, 127)),
    ),
  ];
}

function cut(s: string): { text: string; cut: boolean } {
  const bytes = Buffer.byteLength(s);
  if (bytes <= MAX_OUTPUT_BYTES) return { text: s, cut: false };
  let t = Buffer.from(s).subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
  if (t.endsWith("\uFFFD")) t = t.slice(0, -1);
  return { text: `${t}\n[truncated: ${bytes} bytes, showing the first ${MAX_OUTPUT_BYTES / 1024} KB; narrow it down with head, grep or sed -n]\n`, cut: true };
}

/**
 * Run `command` with the note `name` (text `text`, null: it doesn't exist yet) as the only file. Returns the output
 * and, when the command changed the note, its new text.
 */
export async function runNoteCommand(opts: {
  name: string;
  text: string | null;
  command: string;
  timeoutMs: number;
  signal?: AbortSignal;
  host: NoteShellHost;
  user: string;
}): Promise<NoteShellResult> {
  const fs = new InMemoryFs(undefined, { maxTotalBytes: SCRATCH_BYTES });
  const file = `${NOTE_DIR}/${opts.name}`;
  await fs.mkdir(NOTE_DIR, { recursive: true });
  if (opts.text !== null) await fs.writeFile(file, opts.text);
  const bash = new Bash({
    fs,
    cwd: NOTE_DIR,
    env: { HOME: NOTE_DIR, USER: opts.user, LOGNAME: opts.user, LANG: "C.UTF-8", TERM: "dumb", NOTE: opts.name },
    defenseInDepth: true,
    commands: getCommandNames().filter((n) => !EXCLUDED.has(n)) as CommandName[],
    customCommands: builtins(opts.host, opts.user),
    executionLimitProfile: "hardened",
    executionLimits: {
      maxExecutionTimeMs: opts.timeoutMs,
      maxCommandCount: 100_000,
      maxLoopIterations: 100_000,
      maxAwkIterations: 100_000,
      maxSedIterations: 100_000,
      maxFileSystemBytes: SCRATCH_BYTES,
    },
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener("abort", onAbort);
  let r: ExecResult;
  let timedOut = false;
  try {
    r = await bash.exec(opts.command, { signal: ctl.signal, rawScript: true });
  } catch (e) {
    r = fail(`${e instanceof Error ? e.message : String(e)}\n`, 1);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    timedOut = ctl.signal.aborted && !opts.signal?.aborted;
  }
  let stderr = r.stderr;
  let wrote: string | null | undefined;
  if (timedOut) stderr += `[timed out after ${Math.round(opts.timeoutMs / 1000)} s: nothing was written]\n`;
  else if (!ctl.signal.aborted) {
    const exists = await fs.exists(file);
    const after = exists ? await fs.readFile(file) : null;
    if (after !== opts.text) wrote = after;
    const others = (await fs.readdir(NOTE_DIR)).filter((f) => f !== opts.name);
    if (others.length) stderr += `[grim: only ./${opts.name} is saved; ${others.map((f) => `./${f}`).join(", ")} ${others.length === 1 ? "was" : "were"} discarded]\n`;
  }
  const out = cut(r.stdout);
  const err = cut(stderr);
  return { stdout: out.text, stderr: err.text, exitCode: timedOut ? 124 : r.exitCode, truncated: out.cut || err.cut, wrote };
}

/** stdout, then "[stderr]" and stderr, then "[exit N]" (the text form of a result). */
export function formatResult(r: { stdout: string; stderr: string; exitCode: number }): string {
  const parts: string[] = [];
  if (r.stdout) parts.push(r.stdout.replace(/\n$/, ""));
  if (r.stderr) parts.push(`[stderr]\n${r.stderr.replace(/\n$/, "")}`);
  if (r.exitCode !== 0) parts.push(`[exit ${r.exitCode}]`);
  return parts.length ? parts.join("\n") : "(no output)";
}
