import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

// One directory of our own inside the preload's DATA_DIR (shared by every file in the test process).
const dir = mkdtempSync(join(process.env.DATA_DIR!, "shell-"));
process.env.QUIET_MS = "50";

const { LocalGitStore } = await import("../../src/server/store/localgit.ts");
const { RoomManager } = await import("../../src/server/rooms.ts");
const { RepoService } = await import("../../src/server/repos.ts");
const { db } = await import("../../src/server/db.ts");
const { bunDb } = await import("../../src/server/bun/db-bun.ts");
const { ShellSessions, ShellBusyError } = await import("../../src/server/shell/session.ts");
const { waitForChange } = await import("../../src/server/events.ts");
const ops = await import("../../src/server/ops.ts");

const store = new LocalGitStore(join(dir, "git"));
const rooms = new RoomManager(store);
const repos = new RepoService(store, rooms, bunDb());
const ctx = { store, rooms, repos };

const bot = { id: "agent1", name: "Robo", email: "robo@agents.grimoire", kind: "agent" as const, color: "#0f0" };
const alice = { id: "u1", name: "Alice", email: "alice@example.com", kind: "human" as const, color: "#f00" };

type AccessLevel = "write" | "read" | "none";
const accessMap: Record<string, AccessLevel> = { jot: "write", "jot-secret": "none", "jot-ro": "read" };
const access = async (r: { id: string }) => accessMap[r.id] ?? "none";

const shells = new ShellSessions(ctx);
let session = "s1";

async function sh(command: string, key = session) {
  // cd persists across calls; the shared session starts every command from /workspace.
  return shells.exec(bot, key, access, key === "s1" ? `cd /workspace\n${command}` : command);
}

async function out(command: string, key = session) {
  const r = await sh(command, key);
  if (r.exitCode !== 0) throw new Error(`\`${command}\` failed (${r.exitCode}): ${r.stderr}`);
  return r.stdout;
}

async function committed(repo: string, path: string) {
  const head = await store.head(repo, "main");
  return head ? store.readFile(repo, path, head) : null;
}

beforeAll(async () => {
  // Test files share one database, so use repo ids of our own.
  for (const id of ["jot", "jot-secret", "jot-ro"]) {
    await store.createRepo(id, { branch: "main" });
    db.query("INSERT INTO repos (id, title, kind, branch, status, read_only, created_at) VALUES (?, ?, 'notes', 'main', 'ready', 0, ?)").run(id, id === "jot" ? "Jottings" : id, Date.now());
  }
  await store.commit({
    repo: "jot",
    branch: "main",
    expectedHead: null,
    changes: [
      { path: "Welcome.md", content: "# Welcome to Grimoire\n\nHello.\n" },
      { path: "todo.md", content: "# Todo\n\n- milk\n- eggs\n- bread\n" },
      { path: "projects/alpha.md", content: "# Alpha\n\nStatus: planning\n" },
      { path: "projects/beta.md", content: "# Beta\n\nStatus: done\n" },
      { path: "image.png", content: "not markdown" },
    ],
    message: "seed",
    author: alice,
  });
  for (const id of ["jot-secret", "jot-ro"]) {
    await store.commit({ repo: id, branch: "main", expectedHead: null, changes: [{ path: "a.md", content: "# A\n" }], message: "seed", author: alice });
  }
});

afterAll(() => shells.stop());

describe("reading", () => {
  test("layout: /workspace lists accessible repos, home is /workspace", async () => {
    expect(await out("pwd")).toBe("/workspace\n");
    expect(await out("ls")).toBe("jot\njot-ro\n");
    expect(await out("echo $HOME")).toBe("/workspace\n");
    expect((await sh("ls /workspace/jot-secret")).exitCode).not.toBe(0);
    // Only Markdown files are visible.
    expect(await out("ls /workspace/jot")).toBe("Welcome.md\nprojects\ntodo.md\n");
    expect(await out("ls jot/projects")).toBe("alpha.md\nbeta.md\n");
  });

  test("cat, head, wc, grep -rn, find", async () => {
    expect(await out("cat jot/todo.md")).toBe("# Todo\n\n- milk\n- eggs\n- bread\n");
    expect(await out("head -1 jot/projects/alpha.md")).toBe("# Alpha\n");
    expect(await out("wc -l < jot/todo.md")).toBe("5\n");
    expect(await out("cd jot && grep -rn Status .")).toBe("projects/alpha.md:3:Status: planning\nprojects/beta.md:3:Status: done\n");
    expect(await out("find /workspace/jot -name '*.md'")).toBe(
      "/workspace/jot/Welcome.md\n/workspace/jot/projects/alpha.md\n/workspace/jot/projects/beta.md\n/workspace/jot/todo.md\n",
    );
    expect(await out("stat -c %s jot/todo.md")).toBe(`${"# Todo\n\n- milk\n- eggs\n- bread\n".length}\n`);
  });

  test("reads see live (uncommitted) room text and new files", async () => {
    const room = await rooms.get("jot", "todo.md", "main");
    room.agentEdit(alice, (t) => t.insert(t.length, "- jam\n"));
    expect(await out("tail -1 jot/todo.md")).toBe("- jam\n");
    const fresh = await rooms.get("jot", "draft.md", "main", "draft by alice\n");
    expect(await out("ls jot")).toContain("draft.md");
    expect(await out("cat jot/draft.md")).toBe("draft by alice\n");
    await fresh.flush();
    await room.flush();
  });

  test("pipes, heredocs, loops and substitutions work over the notes", async () => {
    expect(await out("cd jot/projects; for f in *.md; do echo \"$f: $(head -1 $f)\"; done")).toBe("alpha.md: # Alpha\nbeta.md: # Beta\n");
    expect(await out("cat jot/todo.md | grep -c '^- '")).toBe("4\n");
    expect(await out("cat <<'EOF' | tr a-z A-Z\n  hello\nEOF")).toBe("  HELLO\n");
    expect(await out("grep -l done jot/projects/*.md | xargs basename")).toBe("beta.md\n");
  });

  test("paths can't escape the mount; disallowed commands say so", async () => {
    expect((await sh("cat /workspace/jot/../../etc/passwd")).exitCode).not.toBe(0);
    expect((await sh("cat /workspace/jot/.git/config")).exitCode).not.toBe(0);
    for (const c of ["python3 -c 1", "node -e 1", "curl https://example.com", "wget x", "npm i"]) {
      const r = await sh(c);
      expect(r.exitCode).toBe(127);
      expect(r.stderr).toContain("command not available in this shell");
    }
  });
});

describe("writing", () => {
  test("echo > new.md creates a note, committed after the quiet period (or save)", async () => {
    const r = await sh("cd jot && echo '# Ideas' > ideas.md && echo '- one' >> ideas.md && cat ideas.md");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("# Ideas\n- one\n");
    const room = rooms.peek("jot", "ideas.md")!;
    expect(room.text.toString()).toBe("# Ideas\n- one\n");
    expect(await out("ls jot")).toContain("ideas.md");
    await room.flush();
    expect(await committed("jot", "ideas.md")).toBe("# Ideas\n- one\n");
    const [last] = await store.history("jot", "main", "ideas.md", 1);
    expect(last!.authorName).toBe("Robo");
  });

  test("sed -i is a minimal live edit, attributed to the agent", async () => {
    const room = await rooms.get("jot", "todo.md", "main");
    const deltas: unknown[] = [];
    const origins: unknown[] = [];
    const observer = (e: { delta: unknown[]; transaction: { origin: unknown } }) => {
      deltas.push(...e.delta);
      origins.push(e.transaction.origin);
    };
    room.text.observe(observer);
    const before = room.text.toString();
    await out("sed -i 's/eggs/spam/' jot/todo.md");
    room.text.unobserve(observer);
    expect(room.text.toString()).toBe(before.replace("eggs", "spam"));
    const inserted = deltas.map((d) => (d as { insert?: string }).insert ?? "").join("");
    const deleted = deltas.reduce<number>((n, d) => n + ((d as { delete?: number }).delete ?? 0), 0);
    expect(inserted.length).toBeLessThanOrEqual(4);
    expect(deleted).toBeLessThanOrEqual(4);
    expect(origins.every((o) => (o as { user?: { id: string } }).user?.id === bot.id)).toBe(true);
  });

  test(">> appends without replacing; a redirect is one minimal edit", async () => {
    const room = await rooms.get("jot", "todo.md", "main");
    let events = 0;
    const observer = () => events++;
    room.text.observe(observer);
    await out("echo '- tea' >> jot/todo.md");
    expect(room.text.toString()).toEndWith("- jam\n- tea\n");
    // `>` truncates then writes; people must not see the file emptied and retyped.
    const cur = room.text.toString();
    await out(`cat jot/todo.md | sed 's/milk/oat milk/' > /tmp/t && cat /tmp/t > jot/todo.md`);
    room.text.unobserve(observer);
    expect(room.text.toString()).toBe(cur.replace("milk", "oat milk"));
    expect(events).toBe(2);
  });

  test("an edit by someone else while the command runs is kept", async () => {
    const room = await rooms.get("jot", "todo.md", "main");
    const running = sh("sed -i 's/bread/rye bread/' jot/todo.md; sleep 0.3");
    await Bun.sleep(150);
    room.agentEdit(alice, (t) => t.insert(0, "<!-- pinned -->\n"));
    expect((await running).exitCode).toBe(0);
    const text = room.text.toString();
    expect(text).toStartWith("<!-- pinned -->\n# Todo");
    expect(text).toContain("- rye bread\n");
  });

  test("cp, mv (one rename commit), rm", async () => {
    await out("cd jot && cp projects/alpha.md projects/gamma.md");
    expect(await out("cat jot/projects/gamma.md")).toBe("# Alpha\n\nStatus: planning\n");
    await out("save jot/projects/gamma.md");
    expect(await committed("jot", "projects/gamma.md")).toBe("# Alpha\n\nStatus: planning\n");

    await out("cd jot && mv projects/gamma.md archive/gamma.md");
    const [last] = await store.history("jot", "main", "archive/gamma.md", 1);
    expect(last!.message).toBe("Rename projects/gamma.md to archive/gamma.md");
    expect(await committed("jot", "projects/gamma.md")).toBeNull();
    expect(await out("ls jot/archive")).toBe("gamma.md\n");

    await out("rm jot/archive/gamma.md");
    expect(await committed("jot", "archive/gamma.md")).toBeNull();
    expect(await out("ls jot")).not.toContain("archive");
    expect((await sh("rm jot/archive/gamma.md")).exitCode).not.toBe(0);
  });

  test("mkdir, rmdir, touch", async () => {
    await out("mkdir jot/journal && touch jot/journal/day1.md");
    expect(await out("ls jot/journal")).toBe("day1.md\n");
    await out("save jot/journal");
    expect(await committed("jot", "journal/day1.md")).toBe("");
    const r = await sh("rmdir jot/journal");
    expect(r.exitCode).not.toBe(0);
    await out("mkdir jot/empty && rmdir jot/empty");
    expect(await out("ls jot")).not.toContain("empty");
    expect((await sh("mkdir /workspace/newrepo")).stderr).toContain("repos can't be created");
  });

  test("only Markdown files can be written; /tmp is private scratch space", async () => {
    const r = await sh("echo hi > jot/foo.txt");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("only Markdown files");
    expect(r.stderr).toContain("/tmp");
    expect(await committed("jot", "foo.txt")).toBeNull();

    await out("echo scratch > /tmp/data.json && cp jot/todo.md /tmp/");
    expect(await out("cat /tmp/data.json; ls /tmp")).toBe("scratch\ndata.json\nt\ntodo.md\n");
    expect(await out("ls /tmp", "other")).toBe("");
    expect(await store.listFiles("jot", (await store.head("jot", "main"))!)).not.toContain("data.json");
  });

  test("read-only repos can be read but not written", async () => {
    expect(await out("cat jot-ro/a.md")).toBe("# A\n");
    for (const c of ["echo x >> jot-ro/a.md", "echo x > jot-ro/b.md", "rm jot-ro/a.md", "mv jot-ro/a.md jot-ro/c.md", "sed -i s/A/B/ jot-ro/a.md"]) {
      const r = await sh(c);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toMatch(/read-only/);
    }
    expect(await committed("jot-ro", "a.md")).toBe("# A\n");
    expect(rooms.peek("jot-ro", "a.md")).toBeUndefined();
  });
});

describe("session state", () => {
  test("cd and variables persist across exec calls, per session", async () => {
    session = "state";
    await out("cd jot/projects && export GREETING=hi && COUNT=3");
    expect(await out("pwd")).toBe("/workspace/jot/projects\n");
    expect(await out("echo $GREETING $COUNT")).toBe("hi 3\n");
    expect(await out("pwd", "state-2")).toBe("/workspace\n");
    await out("unset GREETING; cd ..");
    expect(await out("echo \"[$GREETING]\"; pwd")).toBe("[]\n/workspace/jot\n");
    session = "s1";
  });

  test("idle sessions expire", async () => {
    await out("cd jot", "expiring");
    shells.sweep(Date.now() + 31 * 60_000);
    expect(await out("pwd", "expiring")).toBe("/workspace\n");
  });
});

describe("grimoire commands", () => {
  test("repos", async () => {
    expect(await out("repos")).toBe("jot     write  Jottings\njot-ro  read   jot-ro\n");
  });

  test("git log, status, diff, show", async () => {
    session = "git";
    await out("cd jot");
    const log = await out("git log --oneline -n 3");
    expect(log.split("\n")[0]).toMatch(/^[0-9a-f]{7} /);
    expect(log.trim().split("\n")).toHaveLength(3);
    expect(await out("git log -n 1 todo.md")).toContain("Author: ");

    // A live, unsaved edit by someone else shows up in status and diff.
    const room = await rooms.get("jot", "projects/beta.md", "main");
    room.agentEdit(alice, (t) => t.insert(t.length, "Owner: Alice\n"));
    expect(await out("git status")).toContain("modified:   projects/beta.md");
    const d = await out("git diff projects");
    expect(d).toContain("--- a/projects/beta.md");
    expect(d).toContain("+Owner: Alice");
    expect(await out("cd projects && git diff beta.md; cd ..")).toBe(d);

    await out("save projects/beta.md");
    expect(await out("git status")).not.toContain("beta.md");
    expect(await out("git diff")).toBe("");
    const show = await out("git show HEAD");
    expect(show).toContain("Author: Alice");
    expect(show).toContain("+Owner: Alice");
    expect(await out("git diff HEAD projects/beta.md")).toContain("+Owner: Alice");
    expect((await sh("git push")).stderr).toContain("committed automatically");
    session = "s1";
  });

  test("save with no arguments commits what this session wrote", async () => {
    session = "saver";
    await out("cd jot && echo '- write tests' >> ideas.md");
    expect(rooms.peek("jot", "ideas.md")!.dirty).toBe(true);
    const r = await out("save");
    expect(r).toMatch(/^saved ideas\.md \([0-9a-f]{7}\)\n$/);
    expect(await committed("jot", "ideas.md")).toBe("# Ideas\n- one\n- write tests\n");
    expect(await out("save")).toBe("nothing to save\n");
    session = "s1";
  });

  test("who lists participants", async () => {
    await out("echo '- x' >> jot/ideas.md");
    expect(await out("who jot/ideas.md")).toContain("Robo (agent, you)");
    expect(await out("who jot/projects/alpha.md")).toContain("nobody");
  });

  test("watch resolves when someone else edits, and its wait doesn't count toward the time limit", async () => {
    const quick = new ShellSessions(ctx, { timeoutMs: 400 });
    try {
      const room = await rooms.get("jot", "Welcome.md", "main");
      const waiting = quick.exec(bot, "w", access, "watch jot/Welcome.md --timeout 5 && tail -1 jot/Welcome.md");
      await Bun.sleep(600);
      room.agentEdit(alice, (t) => t.insert(t.length, "alice was here\n"));
      const r = await waiting;
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("changed: jot/Welcome.md\nalice was here\n");
      const none = await quick.exec(bot, "w", access, "watch jot/Welcome.md --timeout 0.1");
      expect(none.exitCode).toBe(1);
      expect(none.stderr).toContain("no change");
    } finally {
      quick.stop();
    }
  });
});

describe("limits", () => {
  test("output is truncated with a note", async () => {
    const small = new ShellSessions(ctx, { maxOutputBytes: 1000 });
    try {
      const r = await small.exec(bot, "t", access, "seq 1 10000");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.length).toBeLessThan(1300);
      expect(r.stdout).toStartWith("1\n2\n3\n");
      expect(r.stdout).toContain("[output truncated");
      expect(r.truncated).toBe(true);
    } finally {
      small.stop();
    }
  });

  test("commands are stopped after the time limit; runaway loops are cut off", async () => {
    const quick = new ShellSessions(ctx, { timeoutMs: 300 });
    try {
      const t0 = Date.now();
      const r = await quick.exec(bot, "t", access, "echo start; sleep 10; echo never");
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(r.exitCode).toBe(124);
      expect(r.stderr).toContain("timed out");
      // What ran before the cutoff is kept.
      expect(r.stdout).toBe("start\n");
      const loop = await quick.exec(bot, "t", access, "while true; do :; done");
      expect(loop.exitCode).not.toBe(0);
      // The session still works afterwards.
      expect((await quick.exec(bot, "t", access, "echo ok")).stdout).toBe("ok\n");
    } finally {
      quick.stop();
    }
  });
});

describe("merging with what the agent read", () => {
  test("a rewrite based on an earlier read keeps edits made since", async () => {
    session = "merge";
    await out("printf '# Plan\\n\\n- one\\n- two\\n\\nStatus: draft\\n' > jot/plan.md");
    const room = rooms.peek("jot", "plan.md")!;
    expect(await out("cat jot/plan.md")).toBe("# Plan\n\n- one\n- two\n\nStatus: draft\n");
    // Someone edits after the agent read the file...
    room.agentEdit(alice, (t) => t.insert(0, "<!-- pinned -->\n"));
    // ...and the agent writes its new version (computed from what it read) in a later call.
    await out("printf '# Plan\\n\\n- one\\n- two\\n\\nStatus: final\\n' > jot/plan.md");
    expect(room.text.toString()).toBe("<!-- pinned -->\n# Plan\n\n- one\n- two\n\nStatus: final\n");
  });

  test("a rewrite that touches the same place as someone else's edit fails instead of clobbering it", async () => {
    session = "merge";
    const room = rooms.peek("jot", "plan.md")!;
    const seen = await out("cat jot/plan.md");
    room.agentEdit(alice, (t) => {
      const at = t.toString().indexOf("final");
      t.delete(at, 5);
      t.insert(at, "paused");
    });
    // The agent writes a version computed from what it saw, without reading again.
    const r = await sh(`cat > jot/plan.md <<'EOF'\n${seen.replace("final", "done")}EOF`);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("changed by someone else");
    expect(room.text.toString()).toContain("Status: paused");
    // Reading again and redoing the edit works.
    await out("sed -i 's/paused/done/' jot/plan.md");
    expect(room.text.toString()).toEndWith("Status: done\n");
  });

  test(">> after an old read appends at the live end", async () => {
    session = "merge";
    const room = rooms.peek("jot", "plan.md")!;
    await out("cat jot/plan.md");
    room.agentEdit(alice, (t) => t.insert(t.length, "- by alice\n"));
    await out("echo '- by robo' >> jot/plan.md");
    expect(room.text.toString()).toEndWith("Status: done\n- by alice\n- by robo\n");
    session = "s1";
  });

  test("patchFile: edits on neighbouring lines merge; edits at the same spot conflict", async () => {
    const repo = (await repos.get("jot"))!;
    await out("printf 'a\\nb\\nc\\n' > jot/lines.md");
    const room = rooms.peek("jot", "lines.md")!;
    room.agentEdit(alice, (t) => {
      t.delete(2, 1);
      t.insert(2, "B");
    });
    await ops.patchFile(ctx, repo, "lines.md", "a\nb\nc\n", "A\nb\nc\n", bot);
    expect(room.text.toString()).toBe("A\nB\nc\n");
    room.agentEdit(alice, (t) => t.insert(3, "x"));
    await expect(ops.patchFile(ctx, repo, "lines.md", "A\nB\nc\n", "A\nBy\nc\n", bot)).rejects.toThrow("changed by someone else");
    expect(room.text.toString()).toBe("A\nBx\nc\n");
  });
});

describe("unfinished commands and session state", () => {
  test("a timed-out command's writes are discarded", async () => {
    const quick = new ShellSessions(ctx, { timeoutMs: 300 });
    try {
      const before = await out("cat jot/todo.md");
      const r = await quick.exec(bot, "t", access, "echo replaced > /workspace/jot/todo.md; sleep 5");
      expect(r.exitCode).toBe(124);
      expect(r.stderr).toContain("discarded");
      expect(await out("cat jot/todo.md")).toBe(before);
    } finally {
      quick.stop();
    }
  });

  test("exit N keeps cd and variables; syntax errors keep the old state; whoami", async () => {
    session = "exit";
    const r = await sh("cd /workspace/jot/projects; export Z=1; exit 3");
    expect(r.exitCode).toBe(3);
    expect(r.cwd).toBe("/workspace/jot/projects");
    expect(await out("pwd; echo $Z")).toBe("/workspace/jot/projects\n1\n");
    expect((await sh("cd /workspace; if then")).exitCode).toBe(2);
    expect(await out("pwd")).toBe("/workspace/jot/projects\n");
    expect(await out("whoami; echo $USER")).toBe("robo\nrobo\n");
    // Output of a nested shell isn't captured away from its caller.
    expect(await out("x=$(bash -c 'echo inner'); echo \"[$x]\"; echo a b | xargs echo")).toBe("[inner]\na b\n");
    session = "s1";
  });

  test("huge variables aren't carried over", async () => {
    session = "env";
    const r = await sh("export BIG=$(seq 1 20000 | tr -d '\\n'); export SMALL=1");
    expect(r.stderr).toContain("variables not kept");
    expect(await out("echo \"${#BIG}:$SMALL\"")).toBe("0:\n");
    session = "s1";
  });

  test("one command at a time per session; the time limit includes waiting; the queue is bounded", async () => {
    const q = new ShellSessions(ctx, { maxQueued: 1 });
    try {
      const first = q.exec(bot, "q", access, "sleep 0.6; echo first");
      const second = q.exec(bot, "q", access, "echo second", { timeoutMs: 200 });
      expect(() => q.exec(bot, "q", access, "echo third")).toThrow(ShellBusyError);
      expect((await first).stdout).toBe("first\n");
      const r = await second;
      expect(r.exitCode).toBe(124);
      expect(r.stderr).toContain("not run");
      expect((await q.exec(bot, "q", access, "echo ok")).stdout).toBe("ok\n");
    } finally {
      q.stop();
    }
  });

  test("session limits: per actor and in total", async () => {
    const q = new ShellSessions(ctx, { maxSessions: 2 });
    try {
      q.open(bot, "a", access);
      q.open(alice, "b", access);
      await Bun.sleep(2);
      q.touch(bot, "a");
      q.open(bot, "c", access);
      expect(q.size).toBe(2);
      expect(q.has(alice, "b")).toBe(false);
      expect(q.has(bot, "a")).toBe(true);
    } finally {
      q.stop();
    }
  });
});

describe("filesystem details", () => {
  test("ls -l and find don't download files", async () => {
    await store.commit({
      repo: "jot",
      branch: "main",
      expectedHead: await store.head("jot", "main"),
      changes: [
        { path: "big/one.md", content: "x".repeat(1234) },
        { path: "big/two.md", content: "two\n" },
      ],
      message: "more",
      author: alice,
    });
    let reads = 0;
    const readFile = store.readFile.bind(store);
    store.readFile = async (...a: Parameters<typeof store.readFile>) => {
      reads++;
      return readFile(...a);
    };
    try {
      const ls = await out("ls -l jot/big; find jot -name '*.md' | wc -l; stat -c '%s %n' jot/big/one.md");
      expect(ls).toMatch(/1234 [A-Z][a-z]{2} .* one\.md/);
      expect(ls).toContain("1234 jot/big/one.md");
      expect(reads).toBe(0);
    } finally {
      store.readFile = readFile;
    }
  });

  test("invalid UTF-8 is refused; system directories are read-only; /dev/null works", async () => {
    const bin = await sh("echo hi | gzip > jot/bin.md");
    expect(bin.exitCode).not.toBe(0);
    expect(bin.stderr).toContain("binary content");
    expect((await sh("rm -r /bin")).exitCode).not.toBe(0);
    expect((await sh("echo x > /usr/bin/ls")).exitCode).not.toBe(0);
    expect(await out("ls /bin | grep -c '^cat$'; echo gone > /dev/null; cat /dev/null")).toBe("1\n");
  });

  test("mv of an empty folder checks the destination; touch is attributed", async () => {
    await out("mkdir jot/empty-dir");
    const ro = await sh("mv jot/empty-dir jot-ro/empty-dir");
    expect(ro.exitCode).not.toBe(0);
    expect(ro.stderr).toContain("read-only");
    await out("mv jot/empty-dir jot/moved-dir && ls -d jot/moved-dir");
    await out("touch jot/moved-dir/blank.md && save jot/moved-dir/blank.md");
    const [last] = await store.history("jot", "main", "moved-dir/blank.md", 1);
    expect(last!.authorName).toBe("Robo");
    expect(await committed("jot", "moved-dir/blank.md")).toBe("");
  });

  test("save needs write access", async () => {
    const r = await sh("save jot-ro/a.md");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("read-only");
  });

  test("the filesystem works when the store needs host access (Code Storage's SDK reads env, uses timers)", async () => {
    const hostily = new Proxy(store, {
      get(t, k) {
        const v = (t as any)[k];
        if (typeof v !== "function") return v;
        return async (...args: unknown[]) => {
          void Object.keys(process.env).length;
          await new Promise((r) => setTimeout(r, 1));
          return v.apply(t, args);
        };
      },
    });
    const ctx2 = { store: hostily, rooms, repos: new RepoService(hostily, rooms, bunDb()) };
    const s2 = new ShellSessions(ctx2);
    try {
      const r = await s2.exec(bot, "h", access, "grep -c Todo jot/todo.md; ls -l jot/projects | wc -l; git log -n 1 --oneline jot/todo.md | wc -l; echo '- x' >> jot/hostile.md; cat jot/hostile.md");
      expect(r.stderr).toBe("");
      expect(r.stdout).toBe("1\n3\n1\n- x\n");
    } finally {
      s2.stop();
    }
  });
});

describe("git paths", () => {
  test("history of folders and deleted files; diffs show Markdown only", async () => {
    session = "gitpaths";
    await out("cd /workspace/jot");
    expect(await out("git log --oneline big | wc -l")).toBe("1\n");
    await out("echo bye > gone.md && save gone.md && rm gone.md");
    const log = await out("git log --oneline gone.md");
    expect(log).toContain("Delete gone.md");
    expect(log).toContain("Create gone.md");
    const [seed] = (await store.history("jot", "main", "image.png", 1));
    const show = await out(`git show ${seed!.sha}`);
    expect(show).toContain("todo.md");
    expect(show).not.toContain("image.png");
    expect(await out("git status projects")).toContain("nothing to save");
    session = "s1";
  });

  test("watch a folder: resolves on a change inside it; aborted waits end at once", async () => {
    const waiting = sh("watch jot/projects --timeout 5");
    await Bun.sleep(100);
    const room = await rooms.get("jot", "projects/beta.md", "main");
    room.agentEdit(alice, (t) => t.insert(t.length, "more\n"));
    const r = await waiting;
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("changed: jot/projects\n");
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    expect(await waitForChange("jot", undefined, 5000, ac.signal)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(100);
  });
});

describe("workers build", () => {
  // workerd resolves just-bash to its browser bundle, which lacks the Node build's parse/DefenseInDepthBox.
  test("the shell bundles against just-bash's browser entry", async () => {
    const root = join(import.meta.dir, "../../src/server/shell");
    const result = await Bun.build({
      entrypoints: [join(root, "session.ts")],
      conditions: ["browser"],
      target: "bun",
      metafile: true,
      throw: false,
      plugins: [
        {
          name: "trust-workers",
          setup(b) {
            b.onResolve({ filter: /\/trust\.ts$/ }, () => ({ path: join(root, "trust.workers.ts") }));
          },
        },
      ],
    });
    expect(result.logs.filter((l) => l.level === "error").map((l) => l.message)).toEqual([]);
    expect(result.success).toBe(true);
    const inputs = Object.keys(result.metafile!.inputs);
    expect(inputs.some((p) => p.endsWith("just-bash/dist/bundle/browser.js"))).toBe(true);
    expect(inputs.some((p) => p.endsWith("just-bash/dist/bundle/index.js"))).toBe(false);
    expect(inputs.some((p) => p.endsWith("shell/trust.ts"))).toBe(false);
  });
});

test("shell errors keep their names", async () => {
  const { FsError } = await import("../../src/server/shell/fs.ts");
  expect(new ShellBusyError().name).toBe("ShellBusyError");
  expect(new FsError("EINVAL", "x").name).toBe("FsError");
});
