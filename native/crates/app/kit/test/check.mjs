// Headless check of the review kit against kit/demo. Run from the repo root:
//   CHROMIUM=<path to chrome> bun native/crates/app/kit/test/check.mjs [screenshot dir]
// Set BROWSER=webkit to run it in Playwright's WebKit instead.
import { chromium, webkit } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const kit = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.argv[2] || "/tmp/opencode/review-kit-shots";
mkdirSync(shots, { recursive: true });

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = decodeURIComponent(new URL(req.url).pathname);
    const f = Bun.file(join(kit, p.endsWith("/") ? p + "index.html" : p));
    return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 });
  },
});
const url = `http://localhost:${server.port}/demo/`;
const engine = process.env.BROWSER === "webkit" ? webkit : chromium;
const browser = await engine.launch({ executablePath: process.env.BROWSER === "webkit" ? undefined : process.env.CHROMIUM || undefined });
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failures++; };

async function open(width, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  if (opts.host) await page.addInitScript(() => {
    window.__posted = [];
    window.__all = [];
    window.webkit = { messageHandlers: { grim: { postMessage: m => { const v = JSON.parse(m); window.__all.push(v); if (v.type === "review") window.__posted.push(v); } } } };
  });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelectorAll("grim-diff-stack .gs-item").length === 6 && document.querySelectorAll(".gi-frame img").length >= 3);
  await page.evaluate(() => Promise.all([...document.images].map(i => i.decode().catch(() => {}))));
  return { ctx, page, errors };
}

// 1. Render (panel width)
{
  const { ctx, page, errors } = await open(760);
  ok((await page.locator("grim-diff").count()) === 7, "7 diffs rendered (6 from the patch + 1 before/after)");
  const stats = await page.locator(".gs-stat").textContent();
  ok(/6 files/.test(stats), `stack stats: ${stats}`);
  const statuses = await page.$$eval("grim-diff-stack .gs-st", els => els.map(e => e.textContent).join(""));
  ok(statuses === "MARMMD", `TOC statuses ${statuses}`);
  ok((await page.locator("grim-diff[file='wrangler.toml'] .gd-add").count()) >= 2, "before/after diff computed added lines");
  ok((await page.locator(".gh-k").count()) > 10, "syntax colouring present");
  ok((await page.locator(".gd-x").count()) > 2, "intra-line change marks");
  await page.screenshot({ path: join(shots, "01-top.png") });
  await page.locator("grim-diff-stack").scrollIntoViewIfNeeded();
  await page.evaluate(() => document.querySelector("grim-diff-stack").scrollIntoView());
  await page.screenshot({ path: join(shots, "02-stack.png") });

  // 2. TOC dropdown (narrow) + collapse
  await page.click(".gs-files");
  ok(await page.locator(".gs-toc").isVisible(), "Files dropdown opens in narrow panel");
  await page.screenshot({ path: join(shots, "03-toc.png") });
  await page.click(".gs-item >> nth=1");
  const first = page.locator("grim-diff-stack grim-diff").first();
  await first.locator(".gd-toggle").click();
  ok(await first.evaluate(e => e.classList.contains("gd-collapsed")), "collapse via chevron");
  await first.locator(".gd-toggle").click();
  ok(!(await first.evaluate(e => e.classList.contains("gd-collapsed"))), "expand via chevron");
  await page.click("text=Collapse all");
  ok((await page.locator("grim-diff-stack grim-diff.gd-collapsed").count()) === 6, "Collapse all");
  await page.click("text=Expand all");
  // viewed checkbox
  await first.locator(".gd-viewed input").check();
  ok(await first.evaluate(e => e.classList.contains("gd-collapsed")), "Viewed collapses the file");
  ok(await page.locator(".gs-item.gs-viewed").count() === 1, "TOC marks it viewed");
  await first.locator(".gd-viewed input").uncheck();
  await first.locator(".gd-toggle").click();

  // 3. split mode
  await page.locator(".gs-bar .gr-seg button", { hasText: "Split" }).click();
  ok((await page.locator("grim-diff-stack .gd-split").count()) > 20, "split mode rows");
  await page.evaluate(() => document.querySelector("grim-diff-stack grim-diff").scrollIntoView());
  await page.screenshot({ path: join(shots, "04-split.png") });
  await page.locator(".gs-bar .gr-seg button", { hasText: "Unified" }).click();
  ok(errors.length === 0, "no page errors: " + errors.join(" | "));
  await ctx.close();
}

// 4. Wide layout with side TOC + compare slider + lightbox
{
  const { ctx, page } = await open(1300);
  ok(await page.locator(".gs-toc").isVisible(), "TOC shows as a side column when wide");
  const fr = page.locator(".gc-swipe").first();
  await fr.scrollIntoViewIfNeeded();
  const box = await fr.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const pos = await page.locator(".gc").first().getAttribute("data-pos");
  ok(Math.abs(+pos - 25) <= 2, `swipe slider moved to ${pos}%`);
  const clip = await page.locator(".gc-before").first().evaluate(e => e.style.clipPath);
  ok(/75%/.test(clip), `before image clipped: ${clip}`);
  await page.screenshot({ path: join(shots, "05-compare-swipe.png") });
  await page.locator(".gc .gr-seg button", { hasText: "Side by side" }).click();
  ok((await page.locator(".gc-side").count()) === 2, "side by side mode");
  await page.locator(".gi-tile .gi-frame").first().click();
  ok(await page.locator(".gr-lightbox").isVisible(), "click to enlarge");
  await page.keyboard.press("ArrowRight");
  ok(/2 \/ 2/.test(await page.locator(".gl-count").textContent()), "lightbox next");
  await page.screenshot({ path: join(shots, "06-lightbox.png") });
  await page.keyboard.press("Escape");
  ok(!(await page.locator(".gr-lightbox").count()), "Esc closes lightbox");
  await page.evaluate(() => document.querySelector("grim-diff-stack").scrollIntoView());
  await page.screenshot({ path: join(shots, "07-wide.png") });
  await ctx.close();
}

// 5. Annotate: pen on a diff, highlighter on an image, comments; persist; send (fallback)
{
  const { ctx, page, errors } = await open(900);
  await page.click(".gr-toolbar >> text=Annotate");
  ok(await page.evaluate(() => document.documentElement.classList.contains("gr-annotating")), "annotate mode on");
  // pen: circle lines 12-15 of share.ts
  const diff = page.locator("grim-diff-stack grim-diff").first();
  const row = diff.locator('.gd-row[data-n="14"]');
  await row.scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollBy(0, -200));
  const rb = await row.boundingBox();
  const cx = rb.x + 260, cy = rb.y + rb.height / 2;
  await page.mouse.move(cx + 120, cy);
  await page.mouse.down();
  for (let a = 0; a <= 360; a += 15) {
    const t = (a * Math.PI) / 180;
    await page.mouse.move(cx + 120 * Math.cos(t), cy + 40 * Math.sin(t));
  }
  await page.mouse.up();
  ok((await diff.locator(".gr-svg path").count()) === 1, "pen stroke drawn on diff");
  // comment pinned on line 22
  await page.click('.gr-toolbar [aria-label^="Comment"]');
  const r20 = await diff.locator('.gd-row[data-n="20"]').boundingBox();
  await page.mouse.click(r20.x + 420, r20.y + r20.height / 2);
  await page.fill(".gr-editor textarea", "Debounce 150 ms feels slow for local search; try 80?");
  await page.click(".gr-editor >> text=Save");
  ok((await diff.locator(".gr-pin").count()) === 1, "comment pin on diff");
  // highlighter on the link screenshot
  await page.click('.gr-toolbar [aria-label="Highlighter"]');
  const tile = page.locator(".gi-tile .gi-frame").first();
  await tile.scrollIntoViewIfNeeded();
  const tb = await tile.boundingBox();
  await page.mouse.move(tb.x + tb.width * 0.3, tb.y + tb.height * 0.47);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width * 0.7, tb.y + tb.height * 0.47, { steps: 10 });
  await page.mouse.up();
  await page.click('.gr-toolbar [aria-label="Comment: click to pin a note"]');
  await page.mouse.click(tb.x + tb.width * 0.72, tb.y + tb.height * 0.6);
  await page.fill(".gr-editor textarea", "Should expiry default to never?");
  await page.keyboard.press("Control+Enter");
  // pen on the swipe compare
  await page.click('.gr-toolbar [aria-label="Pen"]');
  const sw = page.locator(".gc-swipe");
  await sw.scrollIntoViewIfNeeded();
  const sb = await sw.boundingBox();
  await page.mouse.move(sb.x + sb.width * 0.6, sb.y + sb.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width * 0.85, sb.y + sb.height * 0.22, { steps: 6 });
  await page.mouse.move(sb.x + sb.width * 0.85, sb.y + sb.height * 0.3, { steps: 4 });
  await page.mouse.up();
  ok(await page.locator(".gc").getAttribute("data-pos") === "50", "drawing on the swipe compare doesn't move the slider");
  const n = await page.evaluate(() => grimReview.state().anns.length);
  ok(n === 5, `5 annotations stored (${n})`);
  // undo + redo by drawing again
  await page.keyboard.press("Control+z");
  ok((await page.evaluate(() => grimReview.state().anns.length)) === 4, "undo removes the last stroke");
  await page.mouse.move(sb.x + sb.width * 0.6, sb.y + sb.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width * 0.85, sb.y + sb.height * 0.22, { steps: 6 });
  await page.mouse.up();
  await page.locator(".gc-swipe").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, "08-annotate-image.png") });
  await page.evaluate(() => document.querySelector('grim-diff-stack grim-diff .gd-row[data-n="10"]').scrollIntoView());
  await page.evaluate(() => scrollBy(0, -120));
  await page.screenshot({ path: join(shots, "09-annotate-diff.png") });

  // persists across reload, anchored to the same line
  const before = await diff.locator(".gr-svg path").first().getAttribute("d");
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("grim-diff-stack .gs-item").length === 6);
  await page.evaluate(() => Promise.all([...document.images].map(i => i.decode().catch(() => {}))));
  ok((await page.evaluate(() => grimReview.state().anns.length)) === 5, "annotations persist across reload");
  const after = await page.locator("grim-diff-stack grim-diff").first().locator(".gr-svg path").first().getAttribute("d");
  ok(before === after, "diff stroke redrawn at the same place");
  // switch to split: stroke still anchored to its row
  await page.locator(".gs-bar .gr-seg button", { hasText: "Split" }).click();
  ok((await page.locator("grim-diff-stack grim-diff").first().locator(".gr-svg path").count()) === 1, "stroke survives split mode");
  await page.locator(".gs-bar .gr-seg button", { hasText: "Unified" }).click();

  // tray
  await page.click(".gr-toolbar >> text=Review");
  ok(await page.locator(".gr-tray.open").isVisible(), "tray opens");
  ok((await page.locator(".gt-group").count()) === 3, "tray groups by element (diff, image, compare)");
  await page.fill(".gt-overall", "Looks good overall; two questions inline.");
  await page.fill("grim-note.gn-question .gn-answer", "7 days is fine, but make it visible.");
  await page.locator("grim-checklist input").first().check();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, "10-tray.png") });

  // send in fallback mode -> markdown modal
  await page.click(".gt-send");
  await page.waitForSelector(".gr-modal");
  const p = await page.evaluate(() => grimReview.lastPayload);
  ok(p.type === "grim-review" && p.items.length === 3, `payload: ${p.items.length} items`);
  const d = p.items.find(i => i.kind === "diff");
  ok(d && d.file === "src/client/share.ts" && d.lines.new && d.lines.new[0] <= 14 && d.lines.new[1] >= 20, `diff item lines ${JSON.stringify(d && d.lines)}`);
  ok(d.comments[0].line === 20 && /debounce/.test(d.comments[0].code), `comment anchored to line 20: ${d.comments[0].code}`);
  ok(/^\+/.test(d.excerpt.split("\n").find(l => l.includes("debounce")) || ""), "excerpt has the diff lines");
  const im = p.items.filter(i => i.kind === "image");
  ok(im.length === 2 && im.every(i => i.image && i.image.dataUrl.startsWith("data:image/png")), "image items carry PNGs");
  ok(p.answers.length === 1 && p.checklists[0].items[0].checked, "answers + checklist in payload");
  ok(/## \d\. `src\/client\/share.ts`/.test(p.markdown) && /annot-1.png/.test(p.markdown), "markdown");
  for (const it of p.items) writeFileSync(join(shots, "payload-" + it.image.name), Buffer.from(it.image.dataUrl.split(",")[1], "base64"));
  writeFileSync(join(shots, "payload.md"), p.markdown);
  await page.screenshot({ path: join(shots, "11-fallback.png") });
  ok(errors.length === 0, "no page errors: " + errors.join(" | "));
  await ctx.close();
}

// 6. Host bridge: postMessage + hostResult clears what was sent
{
  const { ctx, page, errors } = await open(800, { host: true });
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("grim-diff-stack .gs-item").length === 6);
  ok(/Send/.test(await page.locator(".gr-tb-send").textContent()), "toolbar says Send inside Grim");
  await page.click(".gr-toolbar >> text=Annotate");
  const wr = page.locator('grim-diff[file="wrangler.toml"] .gd-row[data-n="8"]');
  await wr.scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollBy(0, 150));
  const r = await wr.boundingBox();
  await page.mouse.move(r.x + 40, r.y + 10); await page.mouse.down(); await page.mouse.move(r.x + 300, r.y + 12, { steps: 5 }); await page.mouse.up();
  ok(await page.evaluate(() => window.__all[0].type === "load"), "asks Grim for its saved copy at start");
  await page.waitForFunction(() => window.__all.some(m => m.type === "save" && m.state.anns.length === 1));
  ok(true, "saves to Grim after a change (debounced)");
  await page.click(".gr-tb-send");
  await page.waitForFunction(() => window.__posted.length === 1);
  const m = await page.evaluate(() => window.__posted[0]);
  ok(m.type === "review" && m.payload.items[0].file === "wrangler.toml", "postMessage({type:'review', payload}) to the grim handler");
  ok(/Sending/.test(await page.locator(".gr-tb-send").textContent()), "Sending… while the host works");
  // the host can't tell the session: the reviewer picks one, and it's posted again with it
  await page.evaluate(() => grimReview.hostPick([{ id: "ses_a1", title: "Share links", directory: "/work/grim" }, { id: "ses_b2", title: "Other", directory: "/work" }]));
  await page.screenshot({ path: join(shots, "12-pick.png") });
  await page.click(".gr-pick-item >> nth=0");
  await page.waitForFunction(() => window.__posted.length === 2);
  ok((await page.evaluate(() => window.__posted[1].session)) === "ses_a1", "a picked session is posted with the review");
  await page.evaluate(() => grimReview.hostResult({ ok: true, session: "Share links" }));
  ok((await page.evaluate(() => grimReview.state().anns.length)) === 0, "hostResult ok clears sent annotations");
  ok(/Review sent to Share links/.test(await page.locator(".gr-toast").textContent()), "toast names the session");
  await page.screenshot({ path: join(shots, "13-sent.png") });
  // Grim's newer copy wins (the panel's storage doesn't outlive the app)
  await page.evaluate(() => grimReview.restore({ anns: [{ id: "r1", s: "diff:wrangler.toml", type: "comment", a: "n3", x: 200, y: 8, n: 9, color: "#296d9a", text: "kept by Grim" }], seq: 9, overall: "", answers: { "q-expiry": { q: "?", answer: "never" } }, checks: {}, viewed: {}, t: Date.now() + 1000 }));
  ok((await page.locator('grim-diff[file="wrangler.toml"] .gr-pin').count()) === 1, "restore() brings Grim's copy back");
  ok((await page.inputValue("grim-note.gn-question .gn-answer")) === "never", "restored answers show");
  ok(errors.length === 0, "no page errors: " + errors.join(" | "));
  await ctx.close();
}

await browser.close();
server.stop();
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
