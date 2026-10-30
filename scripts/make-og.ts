// Regenerates the link-preview images in src/client/og/ (served at /og/*; the meta tags: src/server/share-meta.ts):
// og-image.png (1200×630), twitter-card.png (1200×675), og-square.png (1200×1200) and og-demo.png (1200×630).
// Each is an HTML page rendered by headless Chromium (playwright-core) with the real mark (landing/mark.ts) and Inter.
// The app shots are taken live, at 2×, light theme:
//   - a note with an agent's cursor: OG_NOTE_URL (a note in the app) and OG_AGENT_LINK (that workspace's agent link,
//     /a/<id>): the agent "Claude" appends " + demo video" to the "- [ ] Launch post" line while the page is open;
//   - the demo: <OG_BASE>/app/demo (default https://staging.grimnotes.app).
//   OG_NOTE_URL=https://staging.grimnotes.app/app/<workspace>/plan.md OG_AGENT_LINK=https://…/a/<id> bun scripts/make-og.ts
// Without OG_NOTE_URL, the cards that show the note are left as they are (the square and demo cards are still made).
import { chromium, type Browser } from "playwright-core";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PATH, VIEW } from "../src/client/landing/mark.ts";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "src/client/og");
const BASE = (process.env.OG_BASE || "https://staging.grimnotes.app").replace(/\/$/, "");
const NOTE_URL = process.env.OG_NOTE_URL;
const AGENT_LINK = process.env.OG_AGENT_LINK;
const TAGLINE = "A place to think with your agents";
const font = (f: string) => `data:font/woff2;base64,${readFileSync(join(ROOT, "src/client/fonts", f)).toString("base64")}`;

const CSS = `
@font-face { font-family: Inter; font-weight: 100 900; src: url(${font("Inter-roman-latin.woff2")}) format("woff2"); }
* { box-sizing: border-box; margin: 0; }
html, body { width: 100%; height: 100%; }
body { background: #fcfcfb; color: #1d1e22; font-family: Inter, sans-serif; overflow: hidden; position: relative; -webkit-font-smoothing: antialiased; }
.logo { display: flex; align-items: center; gap: 0.36em; font-weight: 800; letter-spacing: 0.04em; line-height: 1; }
.logo svg { flex: none; display: block; height: 1.1em; width: auto; }
.tag { font-weight: 650; letter-spacing: -0.025em; line-height: 1.08; }
.url { color: #8a8a92; font-weight: 550; letter-spacing: 0.01em; }
.win { position: absolute; border-radius: 14px; overflow: hidden; background: #fcfcfb;
  box-shadow: 0 0 0 1px rgba(29,30,34,0.09), 0 2px 6px rgba(29,30,34,0.05), 0 18px 48px -8px rgba(29,30,34,0.16); }
.win img { display: block; width: 100%; }
`;
const mark = `<svg viewBox="${VIEW}" fill="currentColor" aria-hidden="true"><path d="${PATH}"/></svg>`;
const logo = (px: number) => `<div class="logo" style="font-size:${px}px">${mark}<span>GRIM</span></div>`;
const png = (file: string) => `data:image/png;base64,${readFileSync(file).toString("base64")}`;

/** The wide cards: the logo and a headline on the left, the app's window (720×520 CSS px, shown at 0.86) on the right. */
function wide(h: number, shot: string, headline: string, sub: string): string {
  const winTop = Math.round((h - 448) / 2);
  return `<style>${CSS}</style>
  <div style="position:absolute;left:72px;top:0;bottom:0;width:420px;display:flex;flex-direction:column;justify-content:center;gap:34px">
    ${logo(40)}
    <div class="tag" style="font-size:52px">${headline}</div>
    <div class="url" style="font-size:22px">${sub}</div>
  </div>
  <div class="win" style="left:524px;top:${winTop}px;width:620px;height:448px"><img src="${png(shot)}"></div>`;
}

function square(): string {
  return `<style>${CSS}</style>
  <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:64px;padding-bottom:40px">
    <div style="color:#1d1e22">${logo(150)}</div>
    <div class="tag" style="font-size:76px;text-align:center">A place to think<br>with your agents</div>
  </div>
  <div class="url" style="position:absolute;left:0;right:0;bottom:84px;text-align:center;font-size:30px">grimnotes.app</div>`;
}

const tmp = "/tmp/grim-og";
mkdirSync(tmp, { recursive: true });
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  const note = NOTE_URL ? await noteShot(browser) : null;
  const demo = await demoShot(browser);
  if (note) {
    await render(browser, "og-image.png", 630, wide(630, note, TAGLINE, "grimnotes.app"));
    await render(browser, "twitter-card.png", 675, wide(675, note, TAGLINE, "grimnotes.app"));
  } else console.log("OG_NOTE_URL not set: og-image.png and twitter-card.png left as they are");
  await render(browser, "og-square.png", 1200, square());
  await render(browser, "og-demo.png", 630, wide(630, demo, "Try the live demo", "grimnotes.app/app/demo"));
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}

/** A note with the agent's cursor in it, 720×520 at 2×. */
async function noteShot(b: Browser): Promise<string> {
  const run = async (cmd: string) => {
    if (!AGENT_LINK) return;
    const res = await fetch(`${AGENT_LINK}?format=text`, { method: "POST", headers: { "X-Agent-Name": "Claude" }, body: cmd });
    if (!res.ok) throw new Error(`agent link: ${res.status} ${await res.text()}`);
  };
  await run("sed -i 's/^- \\[ \\] Launch post.*$/- [ ] Launch post/' plan.md");
  const p = await page(b, NOTE_URL!);
  await run("sed -i 's/^- \\[ \\] Launch post$/- [ ] Launch post + demo video/' plan.md");
  // the agent's name shows for 2 s after it moves, and while the caret is hovered
  const caret = await p.locator(".rcaret").first().boundingBox({ timeout: 5000 });
  if (caret) await p.mouse.move(caret.x + caret.width / 2, caret.y + caret.height / 2);
  await p.waitForTimeout(300);
  const file = join(tmp, "note.png");
  await p.screenshot({ path: file });
  await p.close();
  return file;
}

async function demoShot(b: Browser): Promise<string> {
  const p = await page(b, `${BASE}/app/demo`);
  const file = join(tmp, "demo.png");
  await p.screenshot({ path: file });
  await p.close();
  return file;
}

/** The app at `url`, 720×520 CSS px at 2×, settled, with the host shown as the public site's. */
async function page(b: Browser, url: string) {
  const p = await b.newPage({ viewport: { width: 720, height: 520 }, deviceScaleFactor: 2, colorScheme: "light" });
  await p.goto(url, { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  await p.evaluate(() => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.nodeValue?.includes("staging.grimnotes.app")) n.nodeValue = n.nodeValue.replace("staging.grimnotes.app", "grimnotes.app");
  });
  return p;
}

async function render(b: Browser, name: string, height: number, html: string): Promise<void> {
  const p = await b.newPage({ viewport: { width: 1200, height }, deviceScaleFactor: 1 });
  await p.setContent(html, { waitUntil: "load" });
  await p.evaluate(() => document.fonts.ready);
  const raw = await p.screenshot({ type: "png" });
  await p.close();
  const out = Buffer.from(raw);
  writeFileSync(join(OUT, name), out);
  console.log(`${name}: 1200×${height}, ${(out.length / 1024).toFixed(0)} KB`);
}
