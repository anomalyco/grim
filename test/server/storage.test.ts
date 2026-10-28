// Tests never reach Code Storage: with Code Storage credentials (and even STORAGE=codestorage) in the environment, a
// test server still uses the local store and makes no network call; a test process that somehow ends up configured
// for Code Storage refuses to start. Each case runs in its own process, so config is read from that environment.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const FAKE = {
  STORAGE: "codestorage",
  CODE_STORAGE_ORG: "fake-org",
  CODE_STORAGE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nnot-a-key\\n-----END PRIVATE KEY-----",
  CODE_STORAGE_API_URL: "http://code-storage.invalid",
  CODE_STORAGE_GIT_URL: "http://code-storage.invalid",
};

// Records every outgoing fetch, then starts a server and reports what it ended up using.
const child = (helper: boolean) => `
${helper ? `await import(${JSON.stringify(join(ROOT, "test/local-storage.ts"))});` : ""}
const calls = [];
const real = globalThis.fetch;
globalThis.fetch = (input, init) => { calls.push(String(input instanceof Request ? input.url : input)); return real(input, init); };
const { config } = await import(${JSON.stringify(join(ROOT, "src/server/config.ts"))});
const { startServer } = await import(${JSON.stringify(join(ROOT, "src/server/index.ts"))});
let out;
try {
  const app = await startServer({ port: 0, quiet: true });
  out = { kind: app.ctx.store.kind, storage: config.storage, org: config.codeStorage.org, calls };
  await app.stop();
} catch (e) {
  out = { error: e.message, calls };
}
console.log(JSON.stringify(out));
process.exit(0);
`;

async function run(helper: boolean, env: Record<string, string>) {
  const dataDir = mkdtempSync(join(process.env.DATA_DIR!, "storage-"));
  const base = { ...process.env };
  delete base.GRIMOIRE_TEST;
  const proc = Bun.spawn(["bun", "-e", child(helper)], {
    cwd: ROOT,
    env: { ...base, ...FAKE, DATA_DIR: dataDir, PORT: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
  await proc.exited;
  const line = stdout.trim().split("\n").pop() ?? "";
  if (!line.startsWith("{")) throw new Error(`child failed: ${stderr}`);
  return { dataDir, out: JSON.parse(line) };
}

test("with Code Storage credentials in the environment, a test server stays local and calls nothing", async () => {
  const { dataDir, out } = await run(true, {});
  expect(out).toEqual({ kind: "local", storage: "local", org: "", calls: [] });
  expect(existsSync(join(dataDir, "git"))).toBe(true);
}, 20000);

test("a test process configured for Code Storage refuses to start", async () => {
  const { out } = await run(false, { GRIMOIRE_TEST: "1" });
  expect(out.error).toContain("tests must use STORAGE=local");
  expect(out.calls).toEqual([]);
}, 20000);
