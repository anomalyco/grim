// The doodle's ink layer in a real browser: redraws put every dot back exactly, and a fading stroke repaints only
// its own box. Usage: bun test/e2e/doodle-ink.mjs (needs playwright-core in /tmp/opencode/pw, like home-doodle.mjs).
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { INK_FADE_MS, INK_MS } from "../../src/shared/doodle.ts";

const built = await Bun.build({ entrypoints: [new URL("../../src/client/landing/doodle/ink.ts", import.meta.url).pathname], target: "browser", format: "iife" });
const code = (await built.outputs[0].text()).replace(/^\(\(\) => \{/, "").replace(/\}\)\(\);\s*$/, "") + "\nwindow.InkLayer = InkLayer;";
const browser = await chromium.launch({ executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell" });
const page = await browser.newPage();
await page.setContent("<body></body>");
await page.addScriptTag({ content: code });
const r = await page.evaluate(([LIFE, FADE]) => {
  const ink = new InkLayer();
  document.body.append(ink.canvas);
  ink.resize(600, 400);
  const now = performance.now();
  const line = (x0, y0, x1, y1) => Array.from({ length: 41 }, (_, i) => [x0 + ((x1 - x0) * i) / 40, y0 + ((y1 - y0) * i) / 40, 0.7]).flat();
  // (a stroke stays until LIFE after it's finished, then fades over FADE; a and c aren't finished)
  const tb = now - (LIFE + FADE / 2);
  ink.push(ink.add("a", "#296d9a", 2.2, now), line(-200, 50, 200, 150), now);
  const b = ink.add("b", "#4f7d4a", 2.2, tb - 500);
  ink.push(b, line(-200, 150, 200, 50), tb - 500);
  ink.done(b, tb); // half way through its fade, crossing a
  ink.push(ink.add("c", "#c08a2e", 2.2, now), line(-250, 300, 250, 320), now);
  ink.flush(now + 1);
  const ctx = ink.canvas.getContext("2d");
  const px = () => ctx.getImageData(0, 0, 600, 400).data;
  const sum = (d, y0, y1) => {
    let s = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < 600; x++) s += d[(y * 600 + x) * 4 + 3];
    return s;
  };
  const d0 = px();
  ink.redraw();
  const d1 = px();
  let diff = 0;
  for (let i = 0; i < d0.length; i++) if (d0[i] !== d1[i]) diff++;
  ink.flush(now + 1000);
  const d2 = px();
  // b's points are gone (and c's haven't started fading)
  ink.flush(now + FADE / 2 + 200);
  const d3 = px();
  // a stroke taken off (a touch that turned into a two-finger scroll) leaves the page as it was
  ink.push(ink.add("d", "#6b4f8f", 2.2, now), line(-220, 60, 180, 330), now + FADE / 2 + 210);
  ink.flush(now + FADE / 2 + 220);
  const d4 = px();
  ink.remove("d");
  const d5 = px();
  let drew = 0;
  let left = 0;
  for (let i = 3; i < d3.length; i += 4) {
    if (d4[i] !== d3[i]) drew++;
    if (d5[i] !== d3[i]) left++;
  }
  return { diff, b: [sum(d1, 40, 160), sum(d2, 40, 160), sum(d3, 40, 160)], c: [sum(d1, 290, 330), sum(d2, 290, 330), sum(d3, 290, 330)], gone: !ink.strokes.has("b"), drew, left, removed: !ink.strokes.has("d") };
}, [INK_MS, INK_FADE_MS]);
await browser.close();

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};
check("a redraw is pixel-identical", r.diff === 0, `${r.diff} bytes differ`);
check("a fading stroke gets lighter, then goes", r.b[1] < r.b[0] * 0.95 && r.b[2] < r.b[1], JSON.stringify(r.b));
check("strokes away from it aren't touched", r.c[0] === r.c[1] && r.c[1] === r.c[2], JSON.stringify(r.c));
check("an expired stroke is dropped", r.gone);
check("a removed stroke leaves no trace", r.drew > 200 && r.left === 0 && r.removed, `${r.drew} pixels drawn, ${r.left} left`);
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
