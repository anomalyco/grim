// The agent shell: each command runs in a fresh just-bash interpreter over the workspace's live notes. Nothing
// (cwd, variables, /tmp) carries over from one call to the next.
import { Bash, getCommandNames, type CommandName, type ScriptNode, type TransformPlugin } from "just-bash";
import { posix } from "node:path";
import { slugify } from "../repos.ts";
import type { Participant } from "../rooms.ts";
import { grimoireCommands } from "./commands.ts";
import { AgentCache, Capture, CAPTURE, NotesFs, ShellFs, WORKSPACE, type AccessFn, type ShellCtx } from "./fs.ts";

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Working directory at the end of the command. */
  cwd: string;
  /** Whether stdout or stderr was cut. */
  truncated?: boolean;
}

export interface ExecOptions {
  /** Overrides the default time limit for this call (not counting `watch`). */
  timeoutMs?: number;
  /** Aborting it stops the command (e.g. when the client disconnects). */
  signal?: AbortSignal;
  /** $HOME: the workspace's folder (default /workspace). */
  home?: string;
  /** Where the command starts (default: home). Must be an existing folder, else NoFolderError. */
  cwd?: string;
  /** What `directory` the caller asked for, as shown in the NoFolderError message. */
  directory?: string;
  /** The key concurrent commands are counted under (`pending`): a caller and workspace (default: the actor's id). */
  limitKey?: string;
}

export interface ShellOptions {
  /** Wall-clock limit per call, counted from the call and not counting time spent in `watch` (default 30 s). */
  timeoutMs?: number;
  /** Max bytes of stdout and of stderr returned per call; the rest is cut with a note (default 200 KB). */
  maxOutputBytes?: number;
  /** Scratch space (/tmp) per call (default 16 MB). */
  scratchBytes?: number;
}

/** Everything one call may take, including queueing and `watch`: below Bun's 120 s idle timeout for HTTP requests. */
export const MAX_CALL_MS = 110_000;
export const MAX_TIMEOUT_S = MAX_CALL_MS / 1000;
export const DEFAULT_TIMEOUT_S = 30;

/** Parse a timeout_seconds argument: a number in [1, MAX_TIMEOUT_S], or the default when absent. Returns an error string otherwise. */
export function parseTimeout(v: unknown): number | string {
  if (v === undefined || v === null) return DEFAULT_TIMEOUT_S;
  if (typeof v !== "number" || !Number.isFinite(v)) return "timeout_seconds must be a number";
  if (v < 1 || v > MAX_TIMEOUT_S) return `timeout_seconds must be between 1 and ${MAX_TIMEOUT_S}`;
  return v;
}

/** Compact, LLM-friendly rendering of a command result. */
export function formatResult(r: Pick<ShellResult, "stdout" | "stderr" | "exitCode">): string {
  let out = r.stdout;
  if (r.stderr) out += `${out && !out.endsWith("\n") ? "\n" : ""}[stderr]\n${r.stderr}`;
  if (r.exitCode !== 0) out += `${out && !out.endsWith("\n") ? "\n" : ""}[exit ${r.exitCode}]`;
  return out || "(no output)";
}

export interface ShellRequest {
  command: string;
  /** The folder to start in, relative to the workspace's root ("" = the root). */
  directory: string;
  /** The caller's agent session (attribution), when it sent a valid one. */
  sessionId?: string;
  timeoutMs: number;
}

const REQUEST_KEYS = new Set(["command", "directory", "session_id", "timeout_seconds"]);
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** An agent session id (session_id) if it's a valid one; anything else is ignored (undefined), never an error. */
export function parseSessionId(v: unknown): string | undefined {
  return typeof v === "string" && SESSION_ID.test(v) ? v : undefined;
}

/** A `directory` argument: a string (or absent: the root). Returns an error string otherwise. */
export function parseDirectory(v: unknown): string | { error: string } {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") return { error: "directory must be a string (a folder relative to the workspace's root)" };
  return v;
}

/**
 * Where a call in `directory` starts: the folder under `root` (the workspace's folder), or null when it would leave
 * it ("..", an absolute path elsewhere). "" and "." are the root itself.
 */
export function resolveDirectory(root: string, directory: string): string | null {
  const rel = directory.trim();
  const abs = posix.resolve(root, rel.startsWith("/") ? `.${rel}` : rel || ".");
  if (rel.split("/").includes("..")) return null;
  return abs === root || abs.startsWith(`${root}/`) ? abs : null;
}

/** The error for a `directory` that isn't a folder of the workspace. */
export const noFolder = (directory: string) => `No folder '${directory}' in this workspace`;

/**
 * Validate an HTTP shell request ({command, directory?, session_id?, timeout_seconds?} plus the X-Agent-Directory
 * and X-Agent-Session-Id headers) as the workspace URL takes it (agent-url.ts). Returns an error message for a bad
 * request; an invalid session_id is dropped, not an error.
 */
export function parseShellRequest(b: Record<string, unknown>, headers: { directory: string | null; sessionId: string | null }): ShellRequest | string {
  for (const k of Object.keys(b)) if (!REQUEST_KEYS.has(k)) return `unknown field: ${k} (expected command, directory, session_id, timeout_seconds)`;
  if (typeof b.command !== "string" || !b.command.trim()) return "command is required (a non-empty string)";
  const directory = parseDirectory(b.directory ?? headers.directory ?? undefined);
  if (typeof directory !== "string") return directory.error;
  const timeout = parseTimeout(b.timeout_seconds);
  if (typeof timeout === "string") return timeout;
  const sessionId = parseSessionId(b.session_id ?? headers.sessionId ?? undefined);
  return { command: b.command, directory, ...(sessionId ? { sessionId } : {}), timeoutMs: timeout * 1000 };
}

/** The folder a call was asked to start in doesn't exist (or isn't a folder). */
export class NoFolderError extends Error {
  override name = "NoFolderError";
}

// Built-ins that need worker threads or the network; they get a "not available" stub instead.
const EXCLUDED = new Set(["sqlite3", "html-to-markdown"]);

type Statement = ScriptNode["statements"][number];
/** Parsed on first use, not at load: a Worker isolate that never runs a shell command doesn't pay for it at startup. */
let template: [Statement] | null = null;
const TEMPLATE = () =>
  (template ??= new Bash().transform(`{ true\n} >>${CAPTURE.stdout} 2>>${CAPTURE.stderr}`).ast.statements as [Statement]);

/**
 * Runs each top-level statement with its output appended to the capture targets, so a command that times out still
 * returns what ran before the cutoff. One-shot (`arm()` before the exec), so nested shells (`bash -c`, xargs) are
 * left alone. Works on the AST, which the interpreter then runs directly.
 */
class Instrument implements TransformPlugin {
  name = "grimoire-instrument";
  private armed = false;

  arm(on = true) {
    this.armed = on;
  }

  transform({ ast }: { ast: ScriptNode }) {
    if (!this.armed) return { ast };
    this.armed = false;
    const statements: Statement[] = [];
    for (const s of ast.statements) {
      if (s.background || s.deferredError) {
        statements.push(s);
        continue;
      }
      const group = structuredClone(TEMPLATE()[0]);
      (group.pipelines[0]!.commands[0] as unknown as { body: Statement[] }).body = [s];
      statements.push(group);
    }
    return { ast: { ...ast, statements } };
  }
}

/** A time limit that can be paused (for `watch`), with a hard stop behind it that can't. */
class Deadline {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private hard: ReturnType<typeof setTimeout>;
  private remaining: number;
  private started = Date.now();
  private paused = 0;
  timedOut = false;

  constructor(
    ms: number,
    hardMs: number,
    private onExpire: () => void,
  ) {
    this.remaining = ms;
    this.hard = setTimeout(() => this.expire(), hardMs);
    this.arm();
  }

  private expire() {
    if (this.timedOut) return;
    this.timedOut = true;
    this.onExpire();
  }

  private arm() {
    this.started = Date.now();
    this.timer = setTimeout(() => this.expire(), Math.max(0, this.remaining));
  }

  pause(): () => void {
    if (this.paused++ === 0 && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.remaining -= Date.now() - this.started;
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--this.paused === 0 && !this.timedOut) this.arm();
    };
  }

  clear() {
    if (this.timer) clearTimeout(this.timer);
    clearTimeout(this.hard);
    this.timer = null;
  }
}

function truncate(s: string, bytes: number, max: number, what: string): { text: string; cut: boolean } {
  if (bytes <= max && Buffer.byteLength(s) <= max) return { text: s, cut: false };
  let cut = Buffer.from(s).subarray(0, max).toString("utf8");
  if (cut.endsWith("\uFFFD")) cut = cut.slice(0, -1);
  return { text: `${cut}\n[${what} truncated: ${bytes} bytes, showing the first ${Math.round(max / 1024)} KB; narrow it down with head, tail, grep or sed -n]\n`, cut: true };
}

/** One call: a fresh interpreter over the notes, used once. */
class ShellRun {
  readonly fs: NotesFs;
  private shellFs: ShellFs;
  private bash: Bash;
  private deadline: Deadline | null = null;
  private instrument = new Instrument();

  constructor(
    ctx: ShellCtx,
    actor: Participant,
    access: AccessFn,
    private opts: Required<ShellOptions>,
    readonly home: string,
    cache: AgentCache,
  ) {
    this.fs = new NotesFs(ctx, actor, access, cache);
    this.shellFs = new ShellFs(this.fs, opts.scratchBytes);
    const user = slugify(actor.name) || "agent";
    this.bash = new Bash({
      fs: this.shellFs,
      cwd: home,
      env: { HOME: home, USER: user, LOGNAME: user, TMPDIR: "/tmp", LANG: "C.UTF-8", TERM: "dumb" },
      defenseInDepth: true,
      commands: getCommandNames().filter((n) => !EXCLUDED.has(n)) as CommandName[],
      customCommands: grimoireCommands({ fs: this.fs, user, pauseDeadline: () => this.deadline?.pause() ?? (() => {}) }),
      executionLimitProfile: "hardened",
      executionLimits: {
        // Our Deadline enforces the real limits; this is the stop behind it.
        maxExecutionTimeMs: MAX_CALL_MS + 5_000,
        // Hardened defaults are 10k; notes work (seq, loops over many files, awk/sed scripts) needs a bit more.
        maxCommandCount: 100_000,
        maxLoopIterations: 100_000,
        maxAwkIterations: 100_000,
        maxSedIterations: 100_000,
        maxArchiveBytes: 32 * 1024 * 1024,
        maxArchiveCompressedBytes: 16 * 1024 * 1024,
        maxArchiveEntryBytes: 16 * 1024 * 1024,
        maxFileSystemBytes: opts.scratchBytes,
      },
    });
    this.bash.registerTransformPlugin(this.instrument);
  }

  private result(stdout: string, stdoutBytes: number, stderr: string, exitCode: number, cwd: string): ShellResult {
    const out = truncate(stdout, stdoutBytes, this.opts.maxOutputBytes, "output");
    const err = truncate(stderr, Buffer.byteLength(stderr), this.opts.maxOutputBytes, "error output");
    return { stdout: out.text, stderr: err.text, exitCode, cwd, ...(out.cut || err.cut ? { truncated: true } : {}) };
  }

  async run(command: string, cwd: string, directory: string, signal: AbortSignal, deadline: Deadline, timeoutMs: number): Promise<ShellResult> {
    if (signal.aborted) return this.result("", 0, "[cancelled; the command was not run]\n", 130, cwd);
    this.fs.beginExec();
    if (cwd !== this.home && !(await this.shellFs.stat(cwd).then((s) => s.isDirectory, () => false))) throw new NoFolderError(noFolder(directory));
    this.deadline = deadline;
    const capture = { stdout: new Capture(this.opts.maxOutputBytes), stderr: new Capture(this.opts.maxOutputBytes) };
    this.shellFs.capture = capture;
    this.instrument.arm();
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    let endCwd = cwd;
    try {
      const r = await this.bash.exec(command, { cwd, env: { PWD: cwd }, replaceEnv: false, signal, rawScript: true });
      stdout = r.stdout;
      stderr = r.stderr;
      exitCode = r.exitCode;
      endCwd = r.env?.PWD ?? cwd;
    } catch (e) {
      stderr = `${e instanceof Error ? e.message : String(e)}\n`;
      exitCode = 1;
    } finally {
      this.instrument.arm(false);
      this.deadline = null;
      this.shellFs.capture = null;
    }
    const stdoutBytes = capture.stdout.bytes + Buffer.byteLength(stdout);
    stdout = capture.stdout.text + stdout;
    stderr = capture.stderr.text + stderr;

    if (exitCode !== 0) for (const e of this.fs.takeWriteErrors()) if (!stderr.includes(e)) stderr += `${e}\n`;
    // An unfinished command's writes are dropped: `cmd > note.md` must not empty the note when cmd didn't finish.
    if (deadline.timedOut || signal.aborted || exitCode === 126) {
      this.fs.discard();
    } else {
      // Writes are applied once the command is done, so a redirect's truncate-then-write lands as one minimal edit.
      const errors = await this.fs.sync();
      if (errors.length) {
        stderr += errors.map((e) => `error: ${e}\n`).join("");
        if (exitCode === 0) exitCode = 1;
      }
    }
    if (deadline.timedOut) {
      stderr += `[timed out after ${Math.round(timeoutMs / 1000)} s; the command was stopped and its unsaved writes were discarded]\n`;
      exitCode = 124;
    } else if (signal.aborted) {
      exitCode = 130;
    }
    return this.result(stdout, stdoutBytes, stderr, exitCode, endCwd);
  }
}

/** Agents whose caches are kept, and for how long unused. */
const CACHED_AGENTS = 50;
/** What all the kept caches may hold together (bytes of text, roughly); the least recently used go first. */
const CACHED_BYTES = 48 * 1024 * 1024;
const CACHE_IDLE_MS = 30 * 60_000;

/** Runs agents' commands, each in a fresh shell, and keeps count of the ones running (for the concurrency caps). */
export class Shells {
  readonly opts: Required<ShellOptions>;
  /** Calls running, per limit key. */
  private running = new Map<string, number>();
  /** Aborts every running call (stop()). */
  private stopAll = new AbortController();
  /** What each agent's (participant id's) calls keep for its next ones: what it read, its views (fs.ts AgentCache). */
  private caches = new Map<string, AgentCache>();

  constructor(
    private ctx: ShellCtx,
    opts: ShellOptions = {},
  ) {
    this.opts = { timeoutMs: 30_000, maxOutputBytes: 200 * 1024, scratchBytes: 16 * 1024 * 1024, ...opts };
  }

  /**
   * Run a command line as `actor`, in a fresh shell starting in `opts.cwd` (default: `opts.home`, default
   * /workspace). The time limit starts now. Throws NoFolderError when the start folder isn't one.
   */
  async exec(actor: Participant, access: AccessFn, command: string, opts: ExecOptions = {}): Promise<ShellResult> {
    const home = opts.home ?? WORKSPACE;
    const cwd = opts.cwd ?? home;
    const key = opts.limitKey ?? actor.id;
    const timeoutMs = Math.min(opts.timeoutMs ?? this.opts.timeoutMs, MAX_CALL_MS);
    const ac = new AbortController();
    const deadline = new Deadline(timeoutMs, MAX_CALL_MS, () => ac.abort());
    const onAbort = () => ac.abort();
    if (opts.signal?.aborted || this.stopAll.signal.aborted) ac.abort();
    else {
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.stopAll.signal.addEventListener("abort", onAbort, { once: true });
    }
    this.running.set(key, (this.running.get(key) ?? 0) + 1);
    try {
      return await new ShellRun(this.ctx, actor, access, this.opts, home, this.cacheOf(actor.id)).run(command, cwd, opts.directory ?? cwd, ac.signal, deadline, timeoutMs);
    } finally {
      const n = (this.running.get(key) ?? 1) - 1;
      if (n > 0) this.running.set(key, n);
      else this.running.delete(key);
      deadline.clear();
      opts.signal?.removeEventListener("abort", onAbort);
      this.stopAll.signal.removeEventListener("abort", onAbort);
    }
  }

  /** An agent's cache (kept for the CACHED_AGENTS most recently used agents, unused for at most CACHE_IDLE_MS). */
  private cacheOf(id: string): AgentCache {
    const now = Date.now();
    let r = this.caches.get(id);
    this.caches.delete(id);
    if (!r || now - r.lastUsed > CACHE_IDLE_MS) r = new AgentCache();
    r.lastUsed = now;
    this.caches.set(id, r);
    let bytes = 0;
    for (const v of this.caches.values()) bytes += v.readBytes + v.viewBytes;
    // least recently used first
    for (const [k, v] of this.caches) {
      if (v === r || (this.caches.size <= CACHED_AGENTS && bytes <= CACHED_BYTES && now - v.lastUsed <= CACHE_IDLE_MS)) break;
      this.caches.delete(k);
      bytes -= v.readBytes + v.viewBytes;
    }
    return r;
  }

  /** Commands running under a limit key. */
  pending(limitKey: string): number {
    return this.running.get(limitKey) ?? 0;
  }

  /** Stop every running command. */
  stop() {
    this.stopAll.abort();
  }
}
