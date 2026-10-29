// The Code Storage private key (and the other secrets) never show up in serialized or logged objects, API responses,
// the agent shell or logged errors. A real (throwaway) P-256 key acts as the sentinel: if any 24-character run of its
// PEM body appears in an output, the test fails.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GitStorage } from "@pierre/storage";

async function throwawayPem(): Promise<string> {
  const k = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", k.privateKey)).toString("base64");
  return `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}
const PEM = await throwawayPem();
const BODY = PEM.replace(/-----[^-]+-----|\s/g, "");
const OTHER = { webhook: "whsec-SENTINEL-7f3a9c2e41", github: "ghsec-SENTINEL-b81d0e5f77", google: "gosec-SENTINEL-c4e2a9d013" };

/** Every place a secret could leak, as text. */
function leaks(text: string): string[] {
  const found: string[] = [];
  const flat = text.replace(/\\n|\s/g, "");
  for (let i = 0; i + 24 <= BODY.length; i += 12) if (flat.includes(BODY.slice(i, i + 24))) found.push(`key@${i}`);
  if (text.includes("PRIVATE KEY")) found.push("PEM header");
  for (const [k, v] of Object.entries(OTHER)) if (text.includes(v)) found.push(k);
  return found;
}

// everything logged during this file
const logged: string[] = [];
const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
for (const k of ["log", "error", "warn", "info"] as const) console[k] = (...args: unknown[]) => void logged.push(args.map((a) => (typeof a === "string" ? a : Bun.inspect(a, { depth: 8 }))).join(" "));

process.env.ALLOW_DEV_LOGIN = "1";
process.env.CODE_STORAGE_PRIVATE_KEY = PEM;
process.env.CODE_STORAGE_WEBHOOK_SECRET = OTHER.webhook;
const { config } = await import("../../src/server/config.ts");
const saved = { ...config };
const savedSecrets = { key: config.codeStorage.key, webhook: config.codeStorage.webhookSecret, github: config.github.clientSecret, google: config.google.clientSecret };
Object.assign(config, { storage: "local", allowDevLogin: true, signIn: true, quietMs: 100, pollMs: 60000, notesRepo: "secret-notes" });
config.codeStorage.key = PEM;
config.codeStorage.webhookSecret = OTHER.webhook;
config.github.clientSecret = OTHER.github;
config.google.clientSecret = OTHER.google;
const { CodeStorageStore, sealSecrets } = await import("../../src/server/store/codestorage.ts");
const { RoutedStore } = await import("../../src/server/store/routed.ts");
const { MemoryStore } = await import("../../src/server/store/memory.ts");
const { startServer } = await import("../../src/server/index.ts");

afterAll(() => {
  Object.assign(console, original);
  Object.assign(config, saved);
  config.codeStorage.key = savedSecrets.key;
  config.codeStorage.webhookSecret = savedSecrets.webhook;
  config.github.clientSecret = savedSecrets.github;
  config.google.clientSecret = savedSecrets.google;
  delete process.env.CODE_STORAGE_PRIVATE_KEY;
  delete process.env.CODE_STORAGE_WEBHOOK_SECRET;
});

const dumps = (o: unknown) => [JSON.stringify(o) ?? "", Bun.inspect(o), Bun.inspect(o, { depth: 20 }), Bun.inspect({ wrapped: o, list: [o] }, { depth: 20 }), String(o)];

describe("the sentinel check itself", () => {
  test("an unsealed SDK client does leak (so the checks below can see a leak)", () => {
    const raw = new GitStorage({ name: "t", key: PEM });
    expect(leaks(JSON.stringify(raw)).length).toBeGreaterThan(0);
    expect(leaks(Bun.inspect(raw.repo({ id: "x" }), { depth: 20 })).length).toBeGreaterThan(0);
  });
});

describe("Code Storage objects", () => {
  // a fake Code Storage that refuses everything (the calls get as far as signing a JWT and sending it)
  let fake: ReturnType<typeof Bun.serve>;
  let store: InstanceType<typeof CodeStorageStore>;
  beforeAll(() => {
    fake = Bun.serve({ port: 0, fetch: () => Response.json({ message: "nope", code: "boom" }, { status: 500 }) });
    store = new CodeStorageStore({ org: "sentinel-org", key: PEM, apiBaseUrl: `http://localhost:${fake.port}`, storageBaseUrl: `localhost:${fake.port}` });
  });
  afterAll(() => fake.stop(true));

  test("the store: stringify / inspect / keys", () => {
    for (const d of dumps(store)) expect(leaks(d)).toEqual([]);
    expect(Object.keys(store)).toEqual(["kind"]);
    const routed = new RoutedStore(store, new Map([["demo", new MemoryStore()]]));
    for (const d of dumps(routed)) expect(leaks(d)).toEqual([]);
    for (const d of dumps({ ctx: { store: routed } })) expect(leaks(d)).toEqual([]);
  });

  test("sealed SDK objects: the client and its repos print redacted and still work", async () => {
    const client = sealSecrets(new GitStorage({ name: "t", key: PEM }), "GitStorage");
    const repo = sealSecrets(client.repo({ id: "x" }), "Repo");
    for (const o of [client, repo]) for (const d of dumps(o)) expect(leaks(d)).toEqual([]);
    expect(JSON.stringify(repo)).toBe('"[Repo (redacted)]"');
    expect(Object.keys(repo)).not.toContain("options");
    // still usable: the key is there for the SDK to sign with
    expect((repo as unknown as { options: { key: string } }).options.key).toBe(PEM);
    const url = await repo.getRemoteURL();
    expect(url).toContain("x");
  });

  test("errors from every store call (after signing a JWT with the key): message, stringify, inspect, logged", async () => {
    const calls: Array<() => Promise<unknown>> = [
      () => store.createRepo("r1", { branch: "main" }),
      () => store.head("r1", "main"),
      () => store.listFiles("r1", "abc123"),
      () => store.readFile("r1", "a.md", "abc123"),
      () => store.commit({ repo: "r1", branch: "main", expectedHead: null, changes: [{ path: "a.md", content: "x" }], message: "m", author: { name: "n", email: "e@x" } }),
      () => store.history("r1", "main", undefined, 5),
    ];
    let n = 0;
    for (const call of calls) {
      try {
        await call();
      } catch (e) {
        n++;
        const err = e as Error;
        for (const d of [err.message, String(err), err.stack ?? "", JSON.stringify(err), ...dumps(err)]) expect(leaks(d)).toEqual([]);
        console.error("[test] store call failed:", err);
      }
    }
    expect(n).toBeGreaterThan(0);
  });
});

describe("the server", () => {
  let app: Awaited<ReturnType<typeof startServer>>;
  let base = "";
  const bodies: string[] = [];
  const get = async (path: string, init?: RequestInit) => {
    const res = await fetch(base + path, init);
    const text = await res.text();
    bodies.push(`${path} ${res.status} ${[...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}\n${text}`);
    return { res, text };
  };
  beforeAll(async () => {
    app = await startServer({ port: 0, quiet: false });
    base = `http://localhost:${app.server.port}`;
  });
  afterAll(async () => {
    await app?.stop();
  });

  test("API responses, the agent shell and the logs never contain a secret", async () => {
    const login = await fetch(`${base}/auth/dev`, { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name: "Sentinel" }), redirect: "manual" });
    const cookie = login.headers.getSetCookie().find((s) => s.startsWith("np_session="))!.split(";")[0]!;
    const json = { cookie, "content-type": "application/json", origin: base };
    for (const p of ["/api/config", "/api/server", "/api/me", "/api/repos", "/api/workspaces", "/api/repos/secret-notes", "/api/repos/secret-notes/tree", "/api/repos/nope", "/api/nope", "/app", "/", "/start", "/connect", "/app.css", "/nope"])
      await get(p, { headers: { cookie } });
    await get("/api/repos/secret-notes/tree");
    await get("/webhooks/codestorage", { method: "POST", body: "{}" });
    await get("/api/repos", { method: "POST", headers: json, body: JSON.stringify({ github: "https://example.invalid/x/y" }) });
    const share = await fetch(`${base}/api/repos/secret-notes/shares`, { method: "POST", headers: json, body: "{}" }).then((r) => r.json() as Promise<{ url: string }>);
    const link = new URL(share.url).pathname;
    await get(link);
    for (const command of ["env", "printenv", "set", "cat /proc/self/environ", "cat /proc/1/environ", "ls -la / /proc", "echo $CODE_STORAGE_PRIVATE_KEY", "repos"])
      await get(link, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command }) });
    await get("/mcp", { method: "POST", headers: { ...json, authorization: "Bearer nope" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(bodies.length).toBeGreaterThan(20);
    for (const b of bodies) expect({ leaks: leaks(b), where: b.slice(0, 80) }).toEqual({ leaks: [], where: b.slice(0, 80) });
    // the shell really ran (so its env output was checked)
    expect(bodies.some((b) => b.includes("HOME="))).toBe(true);
  });

  test("config: secrets readable but not enumerable (logging config can't print them)", () => {
    expect(config.codeStorage.key).toBe(PEM);
    for (const d of dumps(config)) expect(leaks(d)).toEqual([]);
  });

  test("nothing logged during this file contains a secret", () => {
    expect(logged.some((l) => l.includes("[test] store call failed"))).toBe(true);
    for (const l of logged) expect({ leaks: leaks(l), line: l.slice(0, 120) }).toEqual({ leaks: [], line: l.slice(0, 120) });
  });
});
