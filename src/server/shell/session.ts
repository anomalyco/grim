// Persistent agent shell sessions: one just-bash interpreter per (actor, session key), keeping cwd, variables and /tmp.
import { Bash, defineCommand, getCommandNames, type CommandName, type ScriptNode, type TransformPlugin } from "just-bash";
import { slugify } from "../repos.ts";
import type { Participant } from "../rooms.ts";
import { grimoireCommands } from "./commands.ts";
import { Capture, CAPTURE, NotesFs, ShellFs, WORKSPACE, type AccessFn, type ScratchEntry, type ShellCtx } from "./fs.ts";

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Working directory after the command. */
  cwd: string;
  /** Whether stdout or stderr was cut. */
  truncated?: boolean;
}

export interface ExecOptions {
  /** Overrides the session's time limit for this exec (not counting `watch`). */
  timeoutMs?: number;
  /** Aborting it stops the command (e.g. when the client disconnects). */
  signal?: AbortSignal;
}

export interface ShellOptions {
  /** Wall-clock limit per exec, counted from the call and not counting time spent in `watch` (default 30 s). */
  timeoutMs?: number;
  /** Max bytes of stdout and of stderr returned per exec; the rest is cut with a note (default 200 KB). */
  maxOutputBytes?: number;
  /** Sessions unused for this long are dropped (default 30 min). */
  idleMs?: number;
  /** Max sessions per actor; the least recently used one is dropped beyond it (default 50). */
  maxSessionsPerActor?: number;
  /** Max sessions in total (default 1000). */
  maxSessions?: number;
  /** Max commands waiting behind the running one in a session (default 4). */
  maxQueued?: number;
  /** Scratch space (/tmp) per session (default 16 MB). */
  scratchBytes?: number;
  /** Drop idle sessions on a timer (default true); a Durable Object sweeps from its requests and alarm instead. */
  sweepTimer?: boolean;
}

/**
 * What a session keeps across a restart of its host (a ShellDO evicted from memory): where it is, its variables and
 * its scratch files. `scratch` undefined: unchanged since the last save; null: too big to keep (dropped).
 */
export interface SessionState {
  home: string;
  cwd: string;
  env: Record<string, string>;
  lastUsed: number;
  scratch?: ScratchEntry[] | null;
}

/** Where sessions are checkpointed (a ShellDO's SQLite); synchronous, like Durable Object storage. Keys are actor id + "\0" + session key. */
export interface SessionStore {
  load(id: string): SessionState | null;
  save(id: string, state: SessionState): void;
  delete(id: string): void;
  /** Every session whose id starts with `prefix` (an actor's). */
  deletePrefix(prefix: string): void;
  /** Sessions last used before `before`. */
  deleteIdle(before: number): void;
}

/** Most scratch space (/tmp) a checkpoint keeps; a bigger one is not kept. */
export const CHECKPOINT_SCRATCH_BYTES = 4 * 1024 * 1024;

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
  /** Session key, from the body or the X-Shell-Session header. */
  session?: string;
  timeoutMs: number;
}

const SESSION_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const REQUEST_KEYS = new Set(["command", "session", "timeout_seconds"]);

/**
 * Validate an HTTP shell request ({command, session?, timeout_seconds?} plus the X-Shell-Session header) as
 * POST /api/shell and share links take it. Returns an error message for a bad request.
 */
export function parseShellRequest(b: Record<string, unknown>, headerSession: string | null): ShellRequest | string {
  for (const k of Object.keys(b)) if (!REQUEST_KEYS.has(k)) return `unknown field: ${k} (expected command, session, timeout_seconds)`;
  if (typeof b.command !== "string" || !b.command.trim()) return "command is required (a non-empty string)";
  const session = b.session ?? headerSession ?? undefined;
  if (session !== undefined && (typeof session !== "string" || !SESSION_KEY.test(session))) return "session must be 1-128 characters of A-Z a-z 0-9 . _ : -";
  const timeout = parseTimeout(b.timeout_seconds);
  if (typeof timeout === "string") return timeout;
  return { command: b.command, session, timeoutMs: timeout * 1000 };
}
const MAX_ENV_BYTES = 64 * 1024;
const CHECKPOINT = "__grimoire_checkpoint";

export class ShellBusyError extends Error {
  name = "ShellBusyError";
}

/** Variables the interpreter manages itself; never carried over to the next exec. */
const SHELL_VARS = new Set(["?", "PWD", "OLDPWD", "IFS", "OPTIND", "SHELLOPTS", "BASHOPTS", "HOSTNAME", "OSTYPE", "MACHTYPE", "HOSTTYPE", "PPID", "UID", "EUID", "BASHPID", "SHLVL", "RANDOM", "LINENO", "SECONDS", "_", "PIPESTATUS", "FUNCNAME", "GROUPS"]);

// Built-ins that need worker threads or the network; they get a "not available" stub instead.
const EXCLUDED = new Set(["sqlite3", "html-to-markdown"]);

type Statement = ScriptNode["statements"][number];
const TEMPLATE = new Bash().transform(`{ true\n} >>${CAPTURE.stdout} 2>>${CAPTURE.stderr}; ${CHECKPOINT} $?`).ast.statements as [Statement, Statement];

/**
 * Runs each top-level statement with its output appended to the capture targets, followed by a checkpoint that
 * records cwd and variables. So a command that times out still returns what ran before the cutoff, and `exit N`
 * keeps the cd/variables of the statements before it. One-shot (`arm()` before each exec), so nested shells
 * (`bash -c`, xargs) are left alone. Works on the AST, which the interpreter then runs directly.
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
      const group = structuredClone(TEMPLATE[0]);
      (group.pipelines[0]!.commands[0] as unknown as { body: Statement[] }).body = [s];
      statements.push(group, structuredClone(TEMPLATE[1]));
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

export class ShellSession {
  readonly fs: NotesFs;
  private user: string;
  /** Aborts every command running or queued in this session. */
  private stopAll = new AbortController();
  private shellFs: ShellFs;
  private bash: Bash;
  /** Where the shell starts (and goes back to if its cwd disappears); also $HOME. */
  readonly home: string;
  cwd: string;
  env: Record<string, string> = {};
  lastUsed = Date.now();
  private queue: Promise<unknown> = Promise.resolve();
  /** Commands running or waiting in this session. */
  queued = 0;
  private deadline: Deadline | null = null;
  private checkpoint: { cwd: string; env: Map<string, string> } | null = null;
  private instrument = new Instrument();
  /** The scratch version last checkpointed (-1: never). */
  private savedScratch = -1;
  /** Checkpoints of this session, one at a time and in order. */
  saving: Promise<void> = Promise.resolve();

  constructor(
    ctx: ShellCtx,
    actor: Participant,
    access: AccessFn,
    private opts: Required<ShellOptions>,
    home = WORKSPACE,
    /** A checkpoint to continue from. */
    restore?: SessionState,
  ) {
    this.home = home;
    this.cwd = restore?.cwd ?? home;
    if (restore) {
      this.env = restore.env;
      this.lastUsed = restore.lastUsed;
    }
    this.fs = new NotesFs(ctx, actor, access);
    this.shellFs = new ShellFs(this.fs, opts.scratchBytes);
    const user = (this.user = slugify(actor.name) || "agent");
    const session = this;
    this.bash = new Bash({
      fs: this.shellFs,
      cwd: home,
      env: { HOME: home, USER: user, LOGNAME: user, TMPDIR: "/tmp", LANG: "C.UTF-8", TERM: "dumb" },
      defenseInDepth: true,
      commands: getCommandNames().filter((n) => !EXCLUDED.has(n)) as CommandName[],
      customCommands: [
        ...grimoireCommands({
          fs: this.fs,
          get user() {
            return session.user;
          },
          pauseDeadline: () => this.deadline?.pause() ?? (() => {}),
        }),
        defineCommand(CHECKPOINT, async (args, c) => {
          this.checkpoint = { cwd: c.cwd, env: new Map(c.env) };
          return { stdout: "", stderr: "", exitCode: Number(args[0]) || 0 };
        }),
      ],
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
    if (restore?.scratch) {
      // Before the first command runs (commands queue behind it).
      const scratch = restore.scratch;
      this.queue = this.shellFs.importScratch(scratch).catch(() => {});
      this.savedScratch = this.shellFs.scratchVersion;
    }
  }

  /** The state to keep across a restart of the host; the scratch files only when they changed since the last call. */
  async state(): Promise<SessionState> {
    const out: SessionState = { home: this.home, cwd: this.cwd, env: this.env, lastUsed: this.lastUsed };
    const v = this.shellFs.scratchVersion;
    if (v !== this.savedScratch) {
      out.scratch = await this.shellFs.exportScratch(CHECKPOINT_SCRATCH_BYTES);
      this.savedScratch = v;
    }
    return out;
  }

  get actor(): Participant {
    return this.fs.actor;
  }

  /** Same identity, new display: the name shown on cursors and commits (and $USER) follows the caller's latest. */
  setActor(actor: Participant) {
    if (actor === this.fs.actor) return;
    this.fs.actor = actor;
    const user = slugify(actor.name) || "agent";
    if (user !== this.user) {
      this.user = user;
      this.env = { ...this.env, USER: user, LOGNAME: user };
    }
  }

  /** Stop everything running or queued; the session is not used again. */
  abort() {
    this.stopAll.abort();
  }

  /** Run a command line. Calls on one session run one at a time; the time limit starts now, not when it's dequeued. */
  exec(command: string, opts: ExecOptions = {}): Promise<ShellResult> {
    if (this.queued > this.opts.maxQueued) throw new ShellBusyError(`this shell session is busy (${this.queued} commands running or queued); wait for them to finish or use another session`);
    this.queued++;
    this.lastUsed = Date.now();
    const timeoutMs = Math.min(opts.timeoutMs ?? this.opts.timeoutMs, MAX_CALL_MS);
    const ac = new AbortController();
    const deadline = new Deadline(timeoutMs, MAX_CALL_MS, () => ac.abort());
    const onAbort = () => ac.abort();
    if (opts.signal?.aborted || this.stopAll.signal.aborted) ac.abort();
    else {
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.stopAll.signal.addEventListener("abort", onAbort, { once: true });
    }
    const run = this.queue
      .then(() => this.run(command, ac.signal, deadline, timeoutMs))
      .finally(() => {
        this.queued--;
        deadline.clear();
        opts.signal?.removeEventListener("abort", onAbort);
        this.stopAll.signal.removeEventListener("abort", onAbort);
      });
    this.queue = run.catch(() => {});
    return run;
  }

  private result(stdout: string, stdoutBytes: number, stderr: string, exitCode: number): ShellResult {
    const out = truncate(stdout, stdoutBytes, this.opts.maxOutputBytes, "output");
    const err = truncate(stderr, Buffer.byteLength(stderr), this.opts.maxOutputBytes, "error output");
    return { stdout: out.text, stderr: err.text, exitCode, cwd: this.cwd, ...(out.cut || err.cut ? { truncated: true } : {}) };
  }

  private async run(command: string, signal: AbortSignal, deadline: Deadline, timeoutMs: number): Promise<ShellResult> {
    this.lastUsed = Date.now();
    if (signal.aborted) {
      const why = deadline.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s waiting for the previous command in this session` : "cancelled";
      return this.result("", 0, `[${why}; the command was not run]\n`, 124);
    }
    this.fs.beginExec();
    if (!(await this.shellFs.exists(this.cwd).catch(() => false))) {
      this.cwd = (await this.shellFs.exists(this.home).catch(() => false)) ? this.home : WORKSPACE;
    }
    this.deadline = deadline;
    const capture = { stdout: new Capture(this.opts.maxOutputBytes), stderr: new Capture(this.opts.maxOutputBytes) };
    this.shellFs.capture = capture;
    this.checkpoint = null;
    this.instrument.arm();
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      const r = await this.bash.exec(command, { cwd: this.cwd, env: { ...this.env, PWD: this.cwd }, replaceEnv: false, signal, rawScript: true });
      stdout = r.stdout;
      stderr = r.stderr;
      exitCode = r.exitCode;
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
    if (this.checkpoint) stderr += this.keepState(this.checkpoint);

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
    this.lastUsed = Date.now();
    return this.result(stdout, stdoutBytes, stderr, exitCode);
  }

  /** Carry cwd and variables over to the next exec. Returns a warning if the variables are too big to keep. */
  private keepState(c: { cwd: string; env: Map<string, string> }): string {
    this.cwd = c.cwd;
    const env: Record<string, string> = {};
    let bytes = 0;
    for (const [k, v] of c.env) {
      if (SHELL_VARS.has(k) || k.startsWith("BASH")) continue;
      env[k] = v;
      bytes += k.length + v.length;
    }
    if (bytes > MAX_ENV_BYTES) return `[variables not kept for the next command: more than ${MAX_ENV_BYTES / 1024} KB; store big values in /tmp]\n`;
    this.env = env;
    return "";
  }
}

export class ShellSessions {
  private sessions = new Map<string, ShellSession>();
  readonly opts: Required<ShellOptions>;
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(
    private ctx: ShellCtx,
    opts: ShellOptions = {},
    /** Checkpoints sessions after each command, so they outlive the host's memory (ShellDO); none on Bun. */
    private store?: SessionStore,
  ) {
    this.opts = {
      timeoutMs: 30_000,
      maxOutputBytes: 200 * 1024,
      idleMs: 30 * 60_000,
      maxSessionsPerActor: 50,
      maxSessions: 1000,
      maxQueued: 4,
      scratchBytes: 16 * 1024 * 1024,
      sweepTimer: true,
      ...opts,
    };
    if (this.opts.sweepTimer) {
      this.sweeper = setInterval(() => this.sweep(), Math.max(10, Math.min(60_000, this.opts.idleMs)));
      this.sweeper.unref?.();
    }
  }

  private id(actor: Participant, key: string) {
    return `${actor.id}\0${key}`;
  }

  /**
   * The session for this actor and key, created if needed (dropping the least recently used ones beyond the limits).
   * `cwd`: where a new session starts (default /workspace).
   */
  open(actor: Participant, key: string, access: AccessFn, opts: { cwd?: string } = {}): ShellSession {
    const id = this.id(actor, key);
    let s = this.get(actor, key);
    if (!s) {
      s = this.add(id, actor, new ShellSession(this.ctx, actor, access, this.opts, opts.cwd));
      this.persist(id, s);
    }
    s.fs.access = access;
    s.setActor(actor);
    s.lastUsed = Date.now();
    return s;
  }

  private add(id: string, actor: Participant, s: ShellSession): ShellSession {
    this.sessions.set(id, s);
    this.evict((k) => k.startsWith(`${actor.id}\0`), this.opts.maxSessionsPerActor);
    this.evict(() => true, this.opts.maxSessions);
    return s;
  }

  private evict(match: (id: string) => boolean, max: number) {
    const mine = [...this.sessions].filter(([k]) => match(k));
    if (mine.length <= max) return;
    mine.sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
    for (const [k] of mine.slice(0, mine.length - max)) this.drop(k);
  }

  private drop(id: string) {
    this.sessions.delete(id);
    this.store?.delete(id);
  }

  /** Checkpoint a session (after each command); a failure only costs the restart its state. */
  private persist(id: string, s: ShellSession) {
    const store = this.store;
    if (!store) return;
    s.saving = s.saving.then(async () => {
      try {
        const state = await s.state();
        if (this.sessions.get(id) === s) store.save(id, state);
      } catch (e) {
        console.error("[shell] checkpoint:", e);
      }
    });
  }

  /** The session if it exists and hasn't expired (from a checkpoint when it isn't in memory). */
  get(actor: Participant, key: string): ShellSession | undefined {
    const id = this.id(actor, key);
    let s = this.sessions.get(id);
    if (!s && this.store) {
      const saved = this.store.load(id);
      // Its access is set by the caller that opens it (until then it may see nothing).
      if (saved) s = this.add(id, actor, new ShellSession(this.ctx, actor, async () => "none", this.opts, saved.home, saved));
    }
    if (s && Date.now() - s.lastUsed > this.opts.idleMs) {
      this.drop(id);
      return undefined;
    }
    return s;
  }

  has(actor: Participant, key: string) {
    return this.get(actor, key) !== undefined;
  }

  /** Mark a session as used (keeps it from expiring). Returns false if it no longer exists. */
  touch(actor: Participant, key: string) {
    const s = this.get(actor, key);
    if (s) s.lastUsed = Date.now();
    return !!s;
  }

  exec(actor: Participant, key: string, access: AccessFn, command: string, opts?: ExecOptions & { cwd?: string }): Promise<ShellResult> {
    const s = this.open(actor, key, access, { cwd: opts?.cwd });
    const run = s.exec(command, opts);
    if (!this.store) return run;
    // The answer goes out once the session's new state is kept.
    return run.finally(() => {
      this.persist(this.id(actor, key), s);
      return s.saving;
    });
  }

  close(actor: Participant, key: string) {
    this.drop(this.id(actor, key));
  }

  /** End every session of an actor id (e.g. a revoked share link): stops what they're running and drops them. */
  closeActor(actorId: string) {
    for (const [k, s] of this.sessions) {
      if (!k.startsWith(`${actorId}\0`)) continue;
      s.abort();
      this.sessions.delete(k);
    }
    this.store?.deletePrefix(`${actorId}\0`);
  }

  /** Commands running or queued across all of an actor's sessions. */
  pending(actorId: string): number {
    let n = 0;
    for (const [k, s] of this.sessions) if (k.startsWith(`${actorId}\0`)) n += s.queued;
    return n;
  }

  get size() {
    return this.sessions.size;
  }

  sweep(now = Date.now()) {
    for (const [k, s] of this.sessions) if (now - s.lastUsed > this.opts.idleMs) this.sessions.delete(k);
    this.store?.deleteIdle(now - this.opts.idleMs);
  }

  stop() {
    clearInterval(this.sweeper);
    for (const s of this.sessions.values()) s.abort();
    this.sessions.clear();
  }
}

