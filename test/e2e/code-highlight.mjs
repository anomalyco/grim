// End-to-end: code block highlighting through the real server (collab notes, the home page example): the
// highlighter loads only for a note with a known language, its wasm comes from /dist/highlights/<hash>/ (immutable,
// gzip), a remote edit recolours the other person's view. Screenshots to /tmp/opencode/highlight/.
// Usage: bun run build:client && bun test/e2e/code-highlight.mjs
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "np-e2e-"));
process.env.DATA_DIR = dataDir;
process.env.ALLOW_DEV_LOGIN = "1";
process.env.SIGN_IN = "on";
process.env.QUIET_MS = "1500";
process.env.PORT = "0";
const { startServer } = await import("../../src/server/index.ts");
const app = await startServer({ port: 0, quiet: true });
const base = `http://localhost:${app.server.port}`;
const shots = "/tmp/opencode/highlight";
mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};

async function user(name) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1400 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] PAGEERROR`, e.message));
  page.on("console", (m) => m.type() === "error" && !/401/.test(m.text()) && console.log(`[${name}] CONSOLE`, m.text()));
  await page.goto(base + "/auth/dev?next=/app");
  await page.fill("input[name=name]", name);
  await page.click("form button[type=submit], form button");
  await page.waitForURL(/\/app\//, { timeout: 10000 });
  await page.waitForSelector(".mde .ln", { timeout: 10000 });
  return page;
}
const wasmLoads = (page) => page.evaluate(() => performance.getEntriesByType("resource").filter((r) => r.name.includes("highlights.wasm")).map((r) => r.name));
const hk = (page) => page.waitForFunction(() => !!document.querySelector(".mde .ln.in-code [class*=hk]"), null, { timeout: 10000 }).then(() => true, () => false);

const alice = await user("Alice");
check("Welcome note: no highlighter loaded", (await wasmLoads(alice)).length === 0);

const note = [
  "# Code blocks",
  "TypeScript:",
  "```ts",
  "// Greets someone",
  'export function greet(name: string, times = 2): string {',
  "  const parts: string[] = [];",
  "  for (let i = 0; i < times; i++) parts.push(`hello ${name}`);",
  '  return parts.join(", ");',
  "}",
  "```",
  "Rust:",
  "```rust",
  "/// A point.",
  "#[derive(Debug, Clone)]",
  "pub struct Point { x: f64, y: f64 }",
  "impl Point {",
  "    fn len(&self) -> f64 { (self.x * self.x + self.y * self.y).sqrt() }",
  "}",
  "```",
  "Python:",
  "```python",
  "import os",
  "def walk(root: str) -> list[str]:",
  '    """Every file under root."""',
  "    return [os.path.join(d, f) for d, _, fs in os.walk(root) for f in fs if not f.startswith('.')]",
  "```",
  "JSON:",
  "```json",
  '{ "name": "grimoire", "private": true, "version": 3, "tags": ["notes", null] }',
  "```",
  "Shell:",
  "```sh",
  "#!/bin/sh",
  'for f in *.md; do echo "$f: $(wc -l < "$f")"; done | sort -k2 -n # count lines',
  "```",
  "Diff:",
  "```diff",
  "diff --git a/greet.ts b/greet.ts",
  "--- a/greet.ts",
  "+++ b/greet.ts",
  "@@ -1,3 +1,3 @@",
  " export function greet(name: string) {",
  "-  return 'hi ' + name;",
  "+  return `hello ${name}`;",
  " }",
  "```",
  "Patch:",
  "```patch",
  "@@ -10,2 +10,3 @@ fn main() {",
  "-    println!(\"old\");",
  "+    println!(\"new\");",
  "+    println!(\"more\");",
  "```",
  "Unknown language (plain):",
  "```mermaid",
  "graph TD; A-->B",
  "```",
  "",
].join("\n");
await alice.evaluate((content) => fetch("/api/repos/notes/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "Code.md", content }) }), note);
await alice.goto(`${base}/app/notes/Code.md`);
check("note with code: highlighted", await hk(alice));
const loads = await wasmLoads(alice);
check("wasm from /dist/highlights/<hash>/", loads.length === 1 && /\/dist\/highlights\/[0-9a-f]{16}\/highlights\.wasm$/.test(loads[0]), JSON.stringify(loads));
{
  const r = await fetch(loads[0], { headers: { "accept-encoding": "gzip" } });
  const bytes = (await r.arrayBuffer()).byteLength;
  check(
    "wasm served immutable, gzip, application/wasm",
    r.headers.get("cache-control")?.includes("immutable") && r.headers.get("content-encoding") === "gzip" && r.headers.get("content-type") === "application/wasm",
    JSON.stringify([...r.headers]),
  );
  console.log("highlights.wasm transfer:", r.headers.get("content-length"), "bytes gzip,", bytes, "bytes");
}
const colours = await alice.evaluate(() => {
  const out = {};
  for (const ln of document.querySelectorAll(".mde .ln.in-code")) {
    for (const s of ln.querySelectorAll("[class*=hk]")) out[s.textContent.trim()] ??= getComputedStyle(s).color;
  }
  return out;
});
check("ts keyword colour", colours["export function"] === "rgb(41, 109, 154)", JSON.stringify(colours).slice(0, 400));
check("rust comment colour", colours["/// A point."] === "rgb(122, 123, 130)");
const bgs = await alice.evaluate(() => [...document.querySelectorAll(".mde .ln.in-code")].filter((l) => /hkl/.test(l.className)).map((l) => [l.textContent, getComputedStyle(l).backgroundColor]));
check(
  "diff and patch line backgrounds",
  bgs.some(([t, c]) => t.startsWith("+  return") && c === "rgb(233, 243, 236)") && bgs.some(([t, c]) => t.startsWith("-    println") && c === "rgb(247, 239, 229)"),
  JSON.stringify(bgs),
);
check("unknown language plain", await alice.evaluate(() => [...document.querySelectorAll(".mde .ln")].find((l) => l.textContent === "graph TD; A-->B").querySelectorAll("[data-f]").length === 1));
await alice.screenshot({ path: shots + "/web-note.png", fullPage: true });

// Bob opens it; Alice's edit inside the ts block recolours on his side
const bob = await user("Bob");
await bob.goto(`${base}/app/notes/Code.md`);
check("Bob: highlighted", await hk(bob));
await alice.evaluate(() => {
  const v = document.querySelector(".mde").mdeView;
  const at = v.doc.text.indexOf("  const parts");
  v.root.focus();
  v.setSel({ anchor: at, head: at });
});
await alice.keyboard.type("// ");
const recoloured = await bob
  .waitForFunction(() => {
    const l = [...document.querySelectorAll(".mde .ln")].find((l) => l.textContent.startsWith("// "));
    return !!l && getComputedStyle(l.querySelector("[data-f]")).fontStyle === "italic";
  }, null, { timeout: 5000 })
  .then(() => true, () => false);
check("Bob sees Alice's edit recoloured (comment)", recoloured);
await bob.screenshot({ path: shots + "/web-note-bob.png", fullPage: true });

// the home page example (a plain document): typing a block with a language highlights it
await alice.goto(`${base}/`);
await alice.waitForSelector(".home-editor .mde .ln", { timeout: 10000 });
check("home: no highlighter loaded", (await wasmLoads(alice)).length === 0);
await alice.evaluate(() => {
  const v = document.querySelector(".home-editor .mde").mdeView;
  v.root.focus();
  v.setSel({ anchor: v.doc.text.length, head: v.doc.text.length });
});
// (the example ends in a quote: the second Enter leaves it)
await alice.keyboard.press("Enter");
await alice.keyboard.press("Enter");
await alice.keyboard.type("```py");
await alice.keyboard.press("Enter");
await alice.keyboard.type("def f(x): return x + 1  # typed on the home page");
check("home: typed block highlighted", await hk(alice), await alice.evaluate(() => JSON.stringify(document.querySelector(".home-editor .mde").mdeView.doc.text.slice(-120))));
await alice.locator(".home-editor").screenshot({ path: shots + "/web-home-example.png" });

console.log(fails ? `${fails} FAILED` : "all passed");
await browser.close();
await app.stop();
rmSync(dataDir, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
