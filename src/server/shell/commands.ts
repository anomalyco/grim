// Grimoire shell commands: save, who, watch, repos, git (read-only history), and stubs for what isn't here.
import { posix } from "node:path";
import { structuredPatch } from "diff";
import { defineCommand, type Command, type ExecResult } from "just-bash";
import { waitForChange } from "../events.ts";
import type { RepoRow } from "../repos.ts";
import { isMarkdown, type CommitSummary } from "../store/types.ts";
import { isNotePath, WORKSPACE, workspacePath, type NotesFs } from "./fs.ts";

export interface CommandHost {
  fs: NotesFs;
  /** The shell user name ($USER). */
  user: string;
  /** Stop the per-command time limit until the returned function is called (for `watch`). */
  pauseDeadline(): () => void;
}

export const MAX_WATCH_S = 110;

class UsageError extends Error {
  constructor(
    message: string,
    readonly exitCode = 2,
  ) {
    super(message);
  }
}

const ok = (stdout: string, stderr = ""): ExecResult => ({ stdout, stderr, exitCode: 0 });
const fail = (stderr: string, exitCode = 1, stdout = ""): ExecResult => ({ stdout, stderr: stderr.endsWith("\n") ? stderr : stderr + "\n", exitCode });

interface Target {
  repo: RepoRow;
  /** Path inside the repo; "" is the repo root. */
  path: string;
  kind: "file" | "dir" | "missing";
}

/** Run a command body after applying the shell's pending writes; turn thrown errors into exit codes. */
function command(name: string, host: CommandHost, run: (args: string[], cwd: string, signal?: AbortSignal) => Promise<ExecResult>): Command {
  return defineCommand(name, async (args, ctx) => {
    const errors = await host.fs.sync();
    const pre = errors.map((e) => `${name}: ${e}\n`).join("");
    try {
      const r = await run(args, ctx.cwd, ctx.signal);
      return { ...r, stderr: pre + r.stderr, exitCode: r.exitCode || (errors.length ? 1 : 0) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(`${pre}${name}: ${msg}`, e instanceof UsageError ? e.exitCode : 1);
    }
  });
}

async function resolveTarget(host: CommandHost, cwd: string, arg: string | undefined, opts: { mustExist?: boolean } = {}): Promise<Target> {
  const abs = posix.resolve(cwd, arg ?? ".");
  const wp = workspacePath(abs);
  if (!wp?.repo) {
    throw new UsageError(arg ? `${arg}: not inside a repo (paths look like ${WORKSPACE}/<repo>/<file>.md)` : `not inside a repo; cd ${WORKSPACE}/<repo> first or pass a path`);
  }
  const r = await host.fs.repo(wp.repo);
  if (!r) throw new UsageError(`${arg ?? abs}: no repo named ${wp.repo} (run \`repos\`)`, 1);
  const kind = (await host.fs.files(r.row)).has(wp.path) ? "file" : (await host.fs.isDir(r.row, wp.path)) ? "dir" : "missing";
  if (kind === "missing" && opts.mustExist !== false) throw new UsageError(`${arg ?? abs}: no such file or directory`, 1);
  return { repo: r.row, path: wp.path, kind };
}

const relTo = (cwd: string, repo: string, path: string) => posix.relative(cwd, `${WORKSPACE}/${repo}/${path}`) || ".";

const under = (dir: string, p: string) => !dir || p === dir || p.startsWith(dir + "/");

function unified(path: string, before: string | null, after: string): string {
  const patch = structuredPatch(`a/${path}`, `b/${path}`, before ?? "", after, "", "", { context: 3 });
  if (!patch.hunks.length) return "";
  const out = [`diff --git a/${path} b/${path}`, ...(before === null ? ["new file mode 100644"] : []), `--- ${before === null ? "/dev/null" : `a/${path}`}`, `+++ b/${path}`];
  for (const h of patch.hunks) {
    // Like git: an empty side starts at the line before.
    out.push(`@@ -${h.oldLines ? h.oldStart : h.oldStart - 1},${h.oldLines} +${h.newLines ? h.newStart : h.newStart - 1},${h.newLines} @@`, ...h.lines);
  }
  return out.join("\n") + "\n";
}

/** Keep only the parts of a unified diff that are about Markdown files. */
export function markdownOnly(diff: string): string {
  const header = /^diff --git /m.test(diff) ? /^(?=diff --git )/m : /^(?=--- )/m;
  return diff
    .split(header)
    .filter((part) => {
      const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part);
      const paths = m ? [m[1]!, m[2]!] : [/^\+\+\+ b\/(.+)$/m.exec(part)?.[1], /^--- a\/(.+)$/m.exec(part)?.[1]].filter((x): x is string => !!x);
      return !paths.length || paths.some(isMarkdown);
    })
    .join("");
}

// ---- git ----

const HEX = /^[0-9a-f]{7,64}$/i;
const REL_REF = /^(?:HEAD|@)((?:~\d*|\^+)*)$/;

/** Resolve a commit-ish (sha, HEAD, HEAD~N, HEAD^) to a sha, or null if it doesn't look like one. */
async function resolveRef(host: CommandHost, repo: RepoRow, ref: string): Promise<string | null> {
  if (HEX.test(ref)) return ref.toLowerCase();
  const m = REL_REF.exec(ref);
  if (!m) return null;
  let n = 0;
  for (const part of m[1]!.match(/~\d*|\^+/g) ?? []) n += part.startsWith("~") ? Number(part.slice(1) || 1) : part.length;
  if (n > 199) throw new UsageError(`${ref}: too far back (max HEAD~199)`, 1);
  const hist = await host.fs.ctx.store.history(repo.id, repo.branch, undefined, n + 1);
  const c = hist[n];
  if (!c) throw new UsageError(`${ref}: unknown revision`, 128);
  return c.sha;
}

function parseCount(args: string[], i: number): { n: number; skip: number } | null {
  const a = args[i]!;
  let v: string | undefined;
  let skip = 0;
  if (a === "-n" || a === "--max-count") {
    v = args[i + 1];
    skip = 1;
  } else if (a.startsWith("--max-count=")) v = a.slice(12);
  else if (/^-n\d+$/.test(a)) v = a.slice(2);
  else if (/^-\d+$/.test(a)) v = a.slice(1);
  else return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`invalid count: ${v}`);
  return { n: Math.min(n, 200), skip };
}

function formatCommit(c: CommitSummary, oneline: boolean) {
  if (oneline) return `${c.sha.slice(0, 7)} ${c.message}\n`;
  return `commit ${c.sha}\nAuthor: ${c.authorName} <${c.authorEmail}>\nDate:   ${c.date}\n\n    ${c.message}\n\n`;
}

const GIT_HELP = `usage: git <command>  (read-only view of the notes' Git history; edits are committed automatically)
  git log [-n N] [--oneline] [path]   commits, newest first (whole repo, a file or a folder)
  git show <commit> [path]            a commit and its diff
  git diff [path]                     unsaved live edits vs the last commit
  git diff <commit> [path]            the changes made by that commit
  git status [path]                   files with unsaved live edits
<commit> is a sha, HEAD, HEAD~N or HEAD^. Use \`save\` to commit now.
`;

/** A commit's diff (Markdown files only), optionally limited to a file or folder. */
async function commitDiff(host: CommandHost, repo: RepoRow, sha: string, path: string) {
  try {
    return markdownOnly(await host.fs.ctx.store.diff(repo.id, sha, path || undefined));
  } catch {
    throw new UsageError(`commit ${sha} not found`, 128);
  }
}

async function gitLog(host: CommandHost, args: string[], cwd: string) {
  let n = 20;
  let oneline = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const c = parseCount(args, i);
    if (c) {
      n = c.n;
      i += c.skip;
    } else if (a === "--oneline") oneline = true;
    else if (a === "--") continue;
    else if (a.startsWith("-")) throw new UsageError(`git log: unsupported option ${a}`);
    else rest.push(a);
  }
  if (rest.length > 1) throw new UsageError("git log: at most one path");
  const t = await resolveTarget(host, cwd, rest[0], { mustExist: false });
  const hist = await host.fs.ctx.store.history(t.repo.id, t.repo.branch, t.path || undefined, n);
  return ok(hist.map((c) => formatCommit(c, oneline)).join(""));
}

async function gitShow(host: CommandHost, args: string[], cwd: string) {
  const pos = args.filter((a) => a !== "--");
  if (!pos.length || pos.length > 2) throw new UsageError("usage: git show <commit> [path]");
  const t = await resolveTarget(host, cwd, pos[1], { mustExist: false });
  const sha = await resolveRef(host, t.repo, pos[0]!);
  if (!sha) throw new UsageError(`${pos[0]}: not a commit (use a sha, HEAD or HEAD~N)`, 128);
  const recent = await host.fs.ctx.store.history(t.repo.id, t.repo.branch, undefined, 200);
  const c = recent.find((x) => x.sha.startsWith(sha));
  return ok((c ? formatCommit(c, false) : `commit ${sha}\n\n`) + (await commitDiff(host, t.repo, sha, t.path)));
}

async function gitDiff(host: CommandHost, args: string[], cwd: string) {
  const pos = args.filter((a) => a !== "--");
  const opt = pos.find((a) => a.startsWith("-"));
  if (opt) throw new UsageError(`git diff: unsupported option ${opt}`);
  if (pos.length > 2) throw new UsageError("usage: git diff [<commit>] [path]");
  let ref: string | null = null;
  let pathArg: string | undefined = pos[0];
  if (pos.length === 2 || (pos[0] && (HEX.test(pos[0]) || REL_REF.test(pos[0])))) {
    ref = pos[0]!;
    pathArg = pos[1];
  }
  const t = await resolveTarget(host, cwd, pathArg, { mustExist: false });
  if (ref) {
    const sha = await resolveRef(host, t.repo, ref);
    if (!sha) throw new UsageError(`${ref}: not a commit (use a sha, HEAD or HEAD~N)`, 128);
    return ok(await commitDiff(host, t.repo, sha, t.path));
  }
  let out = "";
  for (const r of dirtyRooms(host, t)) out += unified(r.path, r.inBase ? r.baseContent : null, r.text.toString());
  return ok(out);
}

function dirtyRooms(host: CommandHost, t: Target) {
  return host.fs.ctx.rooms
    .inRepo(t.repo.id)
    .filter((r) => r.dirty && under(t.path, r.path))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

async function gitStatus(host: CommandHost, args: string[], cwd: string) {
  const pos = args.filter((a) => a !== "--");
  if (pos.length > 1 || pos.some((a) => a.startsWith("-"))) throw new UsageError("usage: git status [path]");
  const t = await resolveTarget(host, cwd, pos[0], { mustExist: false });
  const dirty = dirtyRooms(host, t);
  let out = `On branch ${t.repo.branch}\n`;
  if (!dirty.length) return ok(out + "nothing to save, all edits are committed\n");
  out += "Unsaved live edits (committed automatically after 15 s without edits, or run `save`):\n";
  for (const r of dirty) out += `\t${r.inBase ? "modified:" : "new file:"}   ${relTo(cwd, t.repo.id, r.path)}\n`;
  return ok(out);
}

// ---- commands ----

const EDIT_HINT = " (use sed -i, cat > file <<'EOF', or >> to edit)";
const PAGER_HINT = " (use cat, head, tail or sed -n)";
const UNAVAILABLE: Record<string, string> = {
  python: "", python3: "", pip: "", pip3: "", node: "", nodejs: "", deno: "", bun: "", npm: "", npx: "", pnpm: "", yarn: "", "js-exec": "",
  perl: "", ruby: "", php: "", go: "", cargo: "", rustc: "", gcc: "", cc: "", make: "", java: "", sqlite3: "",
  curl: "", wget: "", ssh: "", scp: "", rsync: "", nc: "", telnet: "", ftp: "", ping: "", "html-to-markdown": "",
  sudo: "", su: "", apt: "", "apt-get": "", brew: "", docker: "", gh: "",
  vi: EDIT_HINT, vim: EDIT_HINT, nano: EDIT_HINT, emacs: EDIT_HINT, less: PAGER_HINT, more: PAGER_HINT, man: " (try <command> --help)",
};

export function grimoireCommands(host: CommandHost): Command[] {
  const fs = host.fs;
  const cmds: Command[] = [
    defineCommand("whoami", async () => ok(`${host.user}\n`)),

    command("repos", host, async (args) => {
      if (args.length) throw new UsageError("usage: repos");
      const rows = [...(await fs.repos()).values()];
      const w = Math.max(2, ...rows.map((r) => r.row.id.length));
      return ok(rows.map((r) => `${r.row.id.padEnd(w)}  ${r.access.padEnd(5)}  ${r.row.title}${r.row.gh_owner ? ` (github: ${r.row.gh_owner}/${r.row.gh_name})` : ""}\n`).join(""));
    }),

    command("save", host, async (args, cwd) => {
      const keys = new Set<string>();
      if (!args.length) for (const k of fs.written) keys.add(k);
      for (const a of args) {
        const t = await resolveTarget(host, cwd, a);
        if ((await fs.repo(t.repo.id))?.access !== "write") throw new UsageError(`${a}: ${t.repo.id} is read-only for you`, 1);
        if (t.kind === "file") keys.add(`${t.repo.id}\0${t.path}`);
        else for (const r of fs.ctx.rooms.inRepo(t.repo.id)) if (under(t.path, r.path)) keys.add(`${r.repo}\0${r.path}`);
      }
      let out = "";
      let saved = 0;
      for (const k of keys) {
        const [repo, path] = k.split("\0") as [string, string];
        const room = fs.ctx.rooms.peek(repo, path);
        const shown = relTo(cwd, repo, path);
        if (!room?.dirty || (await fs.repo(repo))?.access !== "write") {
          fs.written.delete(k);
          if (args.length) out += `${shown}: nothing to save\n`;
          continue;
        }
        await room.flush();
        fs.written.delete(k);
        saved++;
        out += `saved ${shown} (${room.status().commit?.slice(0, 7) ?? "?"})\n`;
      }
      fs.invalidate();
      if (!saved && !args.length) out = "nothing to save\n";
      return ok(out);
    }),

    command("who", host, async (args, cwd) => {
      if (args.length !== 1) throw new UsageError("usage: who <file>");
      const t = await resolveTarget(host, cwd, args[0]);
      if (t.kind !== "file") throw new UsageError(`${args[0]}: not a file`, 1);
      const people = fs.ctx.rooms.peek(t.repo.id, t.path)?.participants() ?? [];
      if (!people.length) return ok(`nobody has ${args[0]} open\n`);
      return ok(people.map((p) => `${p.name} (${p.kind}${p.id === fs.actor.id ? ", you" : ""})\n`).join(""));
    }),

    command("watch", host, async (args, cwd, signal) => {
      let timeout = 30;
      const rest: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        let v: string | undefined;
        if (a === "--timeout" || a === "-t") v = args[++i];
        else if (a.startsWith("--timeout=")) v = a.slice(10);
        else if (a.startsWith("-")) throw new UsageError(`watch: unknown option ${a}`);
        else {
          rest.push(a);
          continue;
        }
        timeout = Number(v);
        if (!Number.isFinite(timeout) || timeout < 0) throw new UsageError(`watch: invalid timeout ${v}`);
      }
      if (rest.length > 1) throw new UsageError("usage: watch [file|folder] [--timeout SECONDS]");
      timeout = Math.min(timeout, MAX_WATCH_S);
      const t = await resolveTarget(host, cwd, rest[0], { mustExist: false });
      const label = rest[0] ?? relTo(cwd, t.repo.id, t.path);
      // A file (also one that doesn't exist yet), a folder (prefix match), or the whole repo.
      const isFile = t.kind === "file" || (t.kind === "missing" && isNotePath(t.path));
      const watched = !t.path ? undefined : isFile ? t.path : `${t.path}/`;
      const resume = host.pauseDeadline();
      let changed: boolean;
      try {
        changed = await waitForChange(t.repo.id, watched, timeout * 1000, signal);
      } finally {
        resume();
      }
      fs.invalidate(t.repo.id);
      return changed ? ok(`changed: ${label}\n`) : fail(`no change to ${label} within ${timeout}s`, 1);
    }),

    command("git", host, async (args, cwd) => {
      const [sub, ...rest] = args;
      switch (sub) {
        case "log":
          return gitLog(host, rest, cwd);
        case "show":
          return gitShow(host, rest, cwd);
        case "diff":
          return gitDiff(host, rest, cwd);
        case "status":
          return gitStatus(host, rest, cwd);
        case undefined:
        case "help":
        case "--help":
        case "-h":
          return ok(GIT_HELP);
        case "add":
        case "commit":
        case "push":
        case "pull":
        case "fetch":
          return fail(`git ${sub}: not needed here; edits are committed automatically 15 s after the last change (run \`save\` to commit now)`, 1);
        default:
          return fail(`git ${sub}: not supported in this shell\n${GIT_HELP}`, 1);
      }
    }),
  ];
  for (const [name, hint] of Object.entries(UNAVAILABLE)) {
    cmds.push(defineCommand(name, async () => fail(`${name}: command not available in this shell${hint}`, 127)));
  }
  return cmds;
}
