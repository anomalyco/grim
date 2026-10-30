// Cache busting (src/server/assets.ts): the HTML is never cached and links the CSS/JS with ?v=<content hash>; those
// versioned URLs and the hashed chunks/wasm are immutable; bare or stale URLs revalidate.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedNotebook } from "./helpers.ts";

process.env.ALLOW_DEV_LOGIN = "1";
const { config } = await import("../../src/server/config.ts");
// (test files share one process: put the config back for the ones after this)
const saved = { ...config };
Object.assign(config, { storage: "local", allowDevLogin: true, signIn: true, quietMs: 100 });
const { startServer } = await import("../../src/server/index.ts");
const { HTML_HEADERS, immutableDist, indexHtml, staticResponse, writeBootPreload, writeStaticArtifacts } = await import("../../src/server/assets.ts");

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
    await seedNotebook(app.ctx, "asset-notes");
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
    for (const path of ["/", "/app", "/app/notes/Welcome.md", "/scratch"]) {
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

  test("the HTML headers in assets.ts are the ones the server sends", async () => {
    const { res } = await linked();
    for (const [k, v] of Object.entries(HTML_HEADERS)) expect(res.headers.get(k)).toBe(v);
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

// A project root of fixture files in a temp dir, as a build would leave it (no build needed).
function fixtureRoot() {
  const dir = mkdtempSync(join(tmpdir(), "grimoire-assets-"));
  const put = (rel: string, body: string | Uint8Array) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  cpSync(root + "src/client/index.html", join(dir, "src/client/index.html"), { recursive: true });
  put("src/client/app.css", "body { color: red; }\n".repeat(200));
  put("src/client/editor-rs/editor.css", ".cm { color: blue; }\n".repeat(200));
  put("dist/main.js", "console.log('main');\n".repeat(200));
  put("dist/main.js.map", "{}");
  put("dist/index-0eb6y7a4.js", "export const x = 1;\n".repeat(100));
  put("dist/index-0eb6y7a4.js.map", "{}");
  put("dist/fonts/Inter-roman-latin.woff2", "font");
  put("dist/editor-rs/0123456789abcdef/editor_wasm_bg.wasm", "wasm");
  put("dist/editor-rs/0123456789abcdef/editor_wasm_bg.wasm.gz", Bun.gzipSync(new TextEncoder().encode("wasm")));
  return dir;
}

/** Cloudflare `_headers` semantics: every rule whose pattern matches applies; a header set twice is comma-joined. */
function cfHeaders(file: string, path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let match = false;
  for (const line of file.split("\n")) {
    if (!line.trim()) continue;
    if (!line.startsWith(" ")) {
      match = line.endsWith("*") ? path.startsWith(line.slice(0, -1)) : path === line;
      continue;
    }
    if (!match) continue;
    const [k, ...v] = line.trim().split(": ");
    const key = k!.toLowerCase();
    out[key] = out[key] ? `${out[key]}, ${v.join(": ")}` : v.join(": ");
  }
  return out;
}

describe("static build artifacts", () => {
  let dir = "";
  beforeAll(async () => {
    dir = fixtureRoot();
    // an old chunk (a previous build's, kept a week): not listed immutable by name
    writeFileSync(join(dir, "dist/old-zzzzzzzz.js"), "old");
    utimesSync(join(dir, "dist/old-zzzzzzzz.js"), new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
    await writeStaticArtifacts(dir, { since: Date.now() - 60e3 });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("gzip copies of main.js, this build's chunks and the CSS, and the CSS as served at /app.css and /editor.css", () => {
    const gunzip = (f: string) => Buffer.from(Bun.gunzipSync(readFileSync(join(dir, f))));
    expect(gunzip("dist/main.js.gz").equals(readFileSync(join(dir, "dist/main.js")))).toBe(true);
    expect(gunzip("dist/index-0eb6y7a4.js.gz").equals(readFileSync(join(dir, "dist/index-0eb6y7a4.js")))).toBe(true);
    // a previous build's chunk is left as it was
    expect(existsSync(join(dir, "dist/old-zzzzzzzz.js.gz"))).toBe(false);
    for (const [out, src] of [["app.css", "src/client/app.css"], ["editor.css", "src/client/editor-rs/editor.css"]]) {
      expect(readFileSync(join(dir, "dist", out!)).equals(readFileSync(join(dir, src!)))).toBe(true);
      expect(gunzip(`dist/${out}.gz`).equals(readFileSync(join(dir, src!)))).toBe(true);
      expect(readFileSync(join(dir, `dist/${out}.gz`)).length).toBeLessThan(readFileSync(join(dir, src!)).length / 4);
    }
  });

  test("dist/index.html is indexHtml() with each versioned asset linked by its content-named copy", async () => {
    const html = readFileSync(join(dir, "dist/index.html"), "utf8");
    let want = await indexHtml(dir);
    for (const [u, src] of [["/app.css", "src/client/app.css"], ["/editor.css", "src/client/editor-rs/editor.css"], ["/dist/main.js", "dist/main.js"]] as const) {
      const m = new RegExp(`"${u.replace(".", "\\.")}\\?v=([0-9a-f]{12})"`).exec(want)!;
      const name = u.slice(u.lastIndexOf("/") + 1).replace(/\.(\w+)$/, `.${m[1]}.$1`);
      want = want.replace(m[0], `"/dist/${name}"`);
      // the copy is the file, under a name that changes with it
      expect(readFileSync(join(dir, "dist", name)).equals(readFileSync(join(dir, src)))).toBe(true);
    }
    expect(html).toBe(want);
    expect(html).not.toContain("?v=");
  });

  test("_headers: the HTML headers and no-cache on the app pages, immutable on hashed paths only", () => {
    const file = readFileSync(join(dir, "dist/_headers"), "utf8");
    const { "content-type": _, ...html } = HTML_HEADERS;
    for (const path of ["/", "/app", "/app/notes/Welcome.md", "/scratch"]) expect(cfHeaders(file, path)).toEqual(html);
    const copies = [...readFileSync(join(dir, "dist/index.html"), "utf8").matchAll(/"(\/dist\/(?:main|app|editor)\.[0-9a-f]{12}\.(?:js|css))"/g)].map((m) => m[1]!);
    expect(copies.length).toBe(3);
    for (const path of ["/dist/fonts/Inter-roman-latin.woff2", "/dist/editor-rs/0123456789abcdef/editor_wasm_bg.wasm", "/dist/highlights/0123456789abcdef/highlights.wasm", "/dist/index-0eb6y7a4.js", "/dist/index-0eb6y7a4.js.map", ...copies])
      expect(cfHeaders(file, path)).toEqual({ "x-content-type-options": "nosniff", "cache-control": IMMUTABLE });
    for (const path of ["/dist/main.js", "/dist/main.js.map", "/app.css", "/editor.css", "/dist/old-zzzzzzzz.js", "/api/server", "/startx"])
      expect(cfHeaders(file, path)).toEqual({ "x-content-type-options": "nosniff" });
    // Cloudflare's limits: 100 rules, 2,000 characters per line
    expect(file.split("\n").filter((l) => l && !l.startsWith(" ")).length).toBeLessThanOrEqual(100);
    for (const l of file.split("\n")) expect(l.length).toBeLessThanOrEqual(2000);
  });

  test("_redirects moves old /r links under /app, and the old /start guide to the home page", () => {
    expect(readFileSync(join(dir, "dist/_redirects"), "utf8")).toBe("/r /app 308\n/r/* /app/:splat 308\n/start / 308\n");
  });
});

describe("boot preload", () => {
  test("the HTML preloads the chunks main.js imports statically and this build's editor engine", async () => {
    const dir = fixtureRoot();
    try {
      writeFileSync(join(dir, "dist/main.js"), 'import{a as b}from"./shared-abcd1234.js";import("./lazy-efgh5678.js");');
      writeFileSync(join(dir, "dist/shared-abcd1234.js"), 'import"./deep-ijkl9012.js";export const a=1;');
      writeFileSync(join(dir, "dist/deep-ijkl9012.js"), "");
      expect(await indexHtml(dir)).not.toContain("<!--boot-preload-->");
      expect(await indexHtml(dir)).not.toContain("modulepreload");
      writeBootPreload(dir, "0123456789abcdef");
      const html = await indexHtml(dir);
      expect(html).toContain('<link rel="modulepreload" href="/dist/shared-abcd1234.js" />');
      expect(html).toContain('<link rel="modulepreload" href="/dist/deep-ijkl9012.js" />');
      expect(html).not.toContain("lazy-efgh5678");
      expect(html).toContain('<link rel="modulepreload" href="/dist/editor-rs/0123456789abcdef/editor_wasm.js" />');
      expect(html).toContain('<link rel="preload" href="/dist/editor-rs/0123456789abcdef/editor_wasm_bg.wasm" as="fetch" crossorigin />');
      // and the splash is in the HTML itself, before any script
      expect(html.indexOf('id="splash"')).toBeLessThan(html.indexOf("<script"));
      await writeStaticArtifacts(dir);
      expect(readFileSync(join(dir, "dist/index.html"), "utf8")).toContain("/dist/editor-rs/0123456789abcdef/editor_wasm_bg.wasm");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("staticResponse", () => {
  let dir = "";
  beforeAll(async () => {
    dir = fixtureRoot();
    await writeStaticArtifacts(dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const get = async (path: string, gzip = true) => {
    const req = new Request("http://x" + path, { headers: gzip ? { "accept-encoding": "gzip, deflate, br" } : {} });
    return (await staticResponse(req, dir, new URL(req.url).pathname))!;
  };
  const body = async (res: Response) =>
    Buffer.from(res.headers.get("content-encoding") === "gzip" ? Bun.gunzipSync(new Uint8Array(await res.arrayBuffer())) : new Uint8Array(await res.arrayBuffer()));

  test("main.js and the CSS: gzip when accepted, the right type, immutable only at the current version", async () => {
    const html = await indexHtml(dir);
    for (const [url, src, type] of [["/dist/main.js", "dist/main.js", "text/javascript"], ["/app.css", "src/client/app.css", "text/css"], ["/editor.css", "src/client/editor-rs/editor.css", "text/css"]] as const) {
      const versioned = html.match(new RegExp(`"(${url.replace(".", "\\.")}\\?v=[0-9a-f]{12})"`))![1]!;
      const gz = await get(versioned);
      expect(gz.status).toBe(200);
      expect(gz.headers.get("content-encoding")).toBe("gzip");
      expect(gz.headers.get("content-type")).toContain(type);
      expect(gz.headers.get("vary")).toBe("accept-encoding");
      expect(gz.headers.get("cache-control")).toBe(IMMUTABLE);
      expect((await body(gz)).equals(readFileSync(join(dir, src)))).toBe(true);
      const plain = await get(versioned, false);
      expect(plain.headers.get("content-encoding")).toBeNull();
      expect(plain.headers.get("content-type")).toContain(type);
      expect((await body(plain)).equals(readFileSync(join(dir, src)))).toBe(true);
      expect((await get(url)).headers.get("cache-control")).toBe("no-cache");
      expect((await get(url + "?v=000000000000")).headers.get("cache-control")).toBe("no-cache");
    }
  });

  test("a .gz older than its file (a rebuild under --watch) is not served", async () => {
    const main = join(dir, "dist/main.js");
    writeFileSync(main, "console.log('rebuilt');\n");
    utimesSync(join(dir, "dist/main.js.gz"), new Date(Date.now() - 60e3), new Date(Date.now() - 60e3));
    const res = await get("/dist/main.js");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe("console.log('rebuilt');\n");
  });

  test("dist files: immutable hashed paths (gzip when there is a copy), no-cache otherwise", async () => {
    const wasm = await get("/dist/editor-rs/0123456789abcdef/editor_wasm_bg.wasm");
    expect(wasm.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(wasm.headers.get("content-encoding")).toBe("gzip");
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    expect((await body(wasm)).toString()).toBe("wasm");
    const chunk = await get("/dist/index-0eb6y7a4.js");
    expect(chunk.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(chunk.headers.get("content-type")).toContain("text/javascript");
    expect((await get("/dist/fonts/Inter-roman-latin.woff2")).headers.get("cache-control")).toBe(IMMUTABLE);
    const map = await get("/dist/main.js.map");
    expect(map.headers.get("cache-control")).toBe("no-cache");
    expect(map.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("the HTML on every app page, /r and /start redirect, 404 outside dist or for missing files, null elsewhere", async () => {
    for (const path of ["/", "/app", "/app/notes/Welcome.md", "/scratch"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(Object.fromEntries(res.headers)).toMatchObject(HTML_HEADERS);
      // gzipped when accepted
      expect(res.headers.get("content-encoding")).toBe("gzip");
      expect((await body(res)).toString()).toBe(await indexHtml(dir));
      const plain = await get(path, false);
      expect(plain.headers.get("content-encoding")).toBeNull();
      expect(await plain.text()).toBe(await indexHtml(dir));
    }
    const r = await get("/r/notes/a.md?x=1");
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe("/app/notes/a.md?x=1");
    const start = await get("/start");
    expect(start.status).toBe(308);
    expect(start.headers.get("location")).toBe("/");
    for (const path of ["/dist/..%2Fsrc%2Fclient%2Fapp.css", "/dist/missing.js", "/dist/%E0%A4%A"]) expect((await get(path)).status).toBe(404);
    // a pathname that escapes dist/ (the URL parser resolves dot segments, a router may pass one through)
    expect((await staticResponse(new Request("http://x/"), dir, "/dist/../src/client/app.css"))!.status).toBe(404);
    expect(await get("/api/server")).toBeNull();
    expect(await get("/startx")).toBeNull();
  });
});
