// Cache busting (src/server/assets.ts): the HTML is never cached and links the CSS/JS with ?v=<content hash>; those
// versioned URLs and the hashed chunks/wasm are immutable; bare or stale URLs revalidate.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

process.env.ALLOW_DEV_LOGIN = "1";
const { config } = await import("../../src/server/config.ts");
// (test files share one process: put the config back for the ones after this)
const saved = { ...config };
Object.assign(config, { storage: "local", allowDevLogin: true, quietMs: 100, pollMs: 60000, notesRepo: "asset-notes" });
const { startServer } = await import("../../src/server/index.ts");
const { immutableDist } = await import("../../src/server/assets.ts");

const root = new URL("../../", import.meta.url).pathname;
const IMMUTABLE = "public, max-age=31536000, immutable";

// The server reads dist/ under the project root. A fresh checkout has no build: stand in fixture files for the ones
// these tests need (only those missing, removed afterwards), so they pass without `bun run build:client`.
const FIXTURES: Record<string, string> = {
  "dist/main.js": "console.log('fixture main');\n",
  "dist/main.js.map": "{}\n",
  "dist/fixture-a1b2c3d4.js": "console.log('fixture chunk');\n",
};
const created: string[] = [];
let createdDist = false;
function addFixtures() {
  if (!existsSync(root + "dist")) {
    mkdirSync(root + "dist");
    createdDist = true;
  }
  for (const [rel, body] of Object.entries(FIXTURES)) {
    if (existsSync(root + rel) || (rel.includes("fixture-") && readdirSync(root + "dist").some((f) => /-[a-z0-9]{8}\.js$/.test(f)))) continue;
    writeFileSync(root + rel, body);
    created.push(rel);
  }
}
function removeFixtures() {
  for (const rel of created) rmSync(root + rel, { force: true });
  if (createdDist && readdirSync(root + "dist").length === 0) rmSync(root + "dist", { recursive: true, force: true });
}

describe("asset caching", () => {
  let app: Awaited<ReturnType<typeof startServer>>;
  let base = "";
  beforeAll(async () => {
    addFixtures();
    app = await startServer({ port: 0, quiet: true });
    base = `http://localhost:${app.server.port}`;
  });
  afterAll(async () => {
    await app?.stop();
    removeFixtures();
    Object.assign(config, saved);
  });

  const linked = async (path = "/app") => {
    const res = await fetch(base + path);
    const html = await res.text();
    return { res, html, urls: [...html.matchAll(/(?:href|src)="(\/(?:app\.css|editor\.css|dist\/main\.js)[^"]*)"/g)].map((m) => m[1]!) };
  };

  test("the HTML is no-cache on every app route and links each asset with a content-hash version", async () => {
    for (const path of ["/", "/app", "/app/notes/Welcome.md", "/start", "/scratch"]) {
      const { res, urls } = await linked(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("content-type")).toContain("text/html");
      const want = ["/app.css", "/editor.css", "/dist/main.js"];
      expect(urls.length).toBe(want.length);
      for (const [i, u] of urls.entries()) expect(u).toMatch(new RegExp(`^${want[i]!.replace(".", "\\.")}\\?v=[0-9a-f]{12}$`));
    }
  });

  test("a versioned URL is immutable; a bare or stale one revalidates; both serve the current file", async () => {
    const { urls } = await linked();
    for (const u of urls) {
      const v = await fetch(base + u);
      expect(v.status).toBe(200);
      expect(v.headers.get("cache-control")).toBe(IMMUTABLE);
      const bare = await fetch(base + u.replace(/\?.*/, ""));
      expect(bare.headers.get("cache-control")).toBe("no-cache");
      const stale = await fetch(base + u.replace(/v=[0-9a-f]+/, "v=000000000000"));
      expect(stale.headers.get("cache-control")).toBe("no-cache");
      expect(await stale.text()).toBe(await v.text());
    }
  });

  test("the version follows the content", async () => {
    const { urls } = await linked();
    const css = urls.find((u) => u.startsWith("/app.css"))!;
    const text = await Bun.file(root + "src/client/app.css").text();
    const v = new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 12);
    expect(css).toBe(`/app.css?v=${v}`);
  });

  test("hashed chunks, wasm dirs and fonts are immutable; other dist files revalidate", async () => {
    expect(immutableDist("/dist/index-0eb6y7a4.js")).toBe(true);
    expect(immutableDist("/dist/code-live-f724wmv9.js.map")).toBe(true);
    expect(immutableDist("/dist/editor-rs/0123456789abcdef/editor_wasm_bg.wasm")).toBe(true);
    expect(immutableDist("/dist/highlights/0123456789abcdef/highlights.wasm")).toBe(true);
    expect(immutableDist("/dist/fonts/Inter-roman-latin.woff2")).toBe(true);
    expect(immutableDist("/dist/main.js")).toBe(false);
    expect(immutableDist("/dist/main.js.map")).toBe(false);
    const chunk = readdirSync(root + "dist").find((f) => /-[a-z0-9]{8}\.js$/.test(f))!;
    expect((await fetch(`${base}/dist/${chunk}`)).headers.get("cache-control")).toBe(IMMUTABLE);
    const map = await fetch(`${base}/dist/main.js.map`);
    expect(map.status).toBe(200);
    expect(map.headers.get("cache-control")).toBe("no-cache");
  });
});
