// End-to-end: inline code and highlights are one pill. With the caret in `` ` 1. ` `` the revealed backticks and the
// content sit edge to edge on one background, only the outer corners rounded (the backticks in the muted marker
// colour); with the caret elsewhere the content alone is the pill, rounded on both ends. The same for ==highlight==.
// Usage: bun run build:client && bun test/e2e/inline-pill.mjs   (screenshots in /tmp/opencode/inline-code/)
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHOTS = "/tmp/opencode/inline-code";
mkdirSync(SHOTS, { recursive: true });
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-e2e-pill-"));
process.env.ALLOW_DEV_LOGIN = "1";
process.env.SIGN_IN = "on";
process.env.PORT = "0";
const { startServer } = await import("../../src/server/index.ts");
const app = await startServer({ port: 0, quiet: true });
const base = `http://localhost:${app.server.port}`;

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};

const page = await (await browser.newContext({ viewport: { width: 1000, height: 600 } })).newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto(base + "/auth/dev?next=/app");
await page.fill("input[name=name]", "Alice");
await page.click("form button[type=submit], form button");
await page.waitForURL(/\/app\//, { timeout: 10000 });
const doc = "# Pills\n\nA list marker in code: ` 1. ` here.\n\nAnd ==highlighted text== too.";
const created = await page.evaluate(async (content) => {
  const r = await fetch("/api/repos/notes/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "Pills.md", content }) });
  return r.status;
}, doc);
check("note created", created === 201 || created === 200, String(created));
await page.goto(`${base}/app/notes/Pills.md`);
await page.waitForFunction(() => document.querySelector(".mde")?.textContent?.includes("too."), null, { timeout: 10000 });

const caretAt = (needle, k) =>
  page.evaluate(([n, k]) => {
    const v = document.querySelector(".mde").mdeView;
    const i = v.doc.text.indexOf(n) + k;
    v.root.focus();
    v.setSel({ anchor: i, head: i });
  }, [needle, k]);
/** The visible pieces (segments with a box) of style `cls` on line `li`. */
const pieces = (li, cls) =>
  page.evaluate(([li, cls]) => {
    const line = document.querySelector(".mde-content").getElementsByClassName("ln")[li];
    const text = getComputedStyle(line).color;
    return [...line.querySelectorAll(`.${cls}`)]
      .filter((e) => e.getBoundingClientRect().width > 0)
      .map((e) => {
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return {
          cls: e.className,
          text: e.textContent,
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          bg: cs.backgroundColor,
          color: cs.color,
          lineColor: text,
          radius: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(parseFloat),
        };
      });
  }, [li, cls]);

function onePill(tag, ps, n, opts) {
  const ok = (name, cond) => check(`${tag}: ${name}`, cond, JSON.stringify(ps));
  ok(`${n} pieces`, ps.length === n);
  if (ps.length !== n) return;
  ok("edge to edge (no gaps)", ps.every((p, i) => i === 0 || Math.abs(p.left - ps[i - 1].right) < 0.5));
  ok("one background, on every piece", ps.every((p) => p.bg === ps[0].bg) && ps[0].bg !== "rgba(0, 0, 0, 0)");
  ok("the same height", ps.every((p) => Math.abs(p.top - ps[0].top) < 0.5 && Math.abs(p.bottom - ps[0].bottom) < 0.5));
  const [tl, , , bl] = ps[0].radius;
  const [, tr, br] = ps[n - 1].radius;
  ok(`outer corners rounded (${opts.r}px)`, [tl, bl, tr, br].every((r) => r === opts.r));
  const inner = [...ps.slice(0, -1).flatMap((p) => [p.radius[1], p.radius[2]]), ...ps.slice(1).flatMap((p) => [p.radius[0], p.radius[3]])];
  ok("inner corners square", inner.every((r) => r === 0));
  if (opts.markers) ok("the delimiters muted, the content not", ps[0].color !== ps[1].color && ps[0].color === ps[n - 1].color && ps[1].color === ps[1].lineColor);
}

// collapsed: the content alone, rounded both ends
await caretAt("# Pills", 0);
await page.waitForTimeout(100);
let ps = await pieces(2, "code");
onePill("code, collapsed", ps, 1, { r: 4 });
check("code, collapsed: the pill is just ' 1. '", ps[0]?.text === " 1. ", JSON.stringify(ps.map((p) => p.text)));
await page.locator(".mde .ln >> nth=2").screenshot({ path: `${SHOTS}/e2e-code-collapsed.png` });

// revealed: backtick, content, backtick as one pill
await caretAt("` 1. `", 2);
await page.waitForTimeout(100);
ps = await pieces(2, "code");
onePill("code, revealed", ps, 3, { r: 4, markers: true });
check("code, revealed: ` + ' 1. ' + `", ps.map((p) => p.text).join("|") === "`| 1. |`", JSON.stringify(ps.map((p) => p.text)));
await page.locator(".mde .ln >> nth=2").screenshot({ path: `${SHOTS}/e2e-code-revealed.png` });

// highlight: the same rule
await caretAt("==highlighted", 4);
await page.waitForTimeout(100);
ps = await pieces(4, "hl");
onePill("highlight, revealed", ps, 3, { r: 2, markers: true });
await page.locator(".mde .ln >> nth=4").screenshot({ path: `${SHOTS}/e2e-hl-revealed.png` });
await caretAt("# Pills", 0);
await page.waitForTimeout(100);
onePill("highlight, collapsed", await pieces(4, "hl"), 1, { r: 2 });

await browser.close();
await app.stop();
rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
