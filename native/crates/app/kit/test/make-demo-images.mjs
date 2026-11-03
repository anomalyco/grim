// Renders the demo's mock screenshots into kit/demo/img/. Run: bun kit/test/make-demo-images.mjs
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "demo", "img");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const page = await browser.newPage({ viewport: { width: 760, height: 460 }, deviceScaleFactor: 1 });

const css = `body{margin:0;font:14px/1.45 -apple-system,system-ui,"Segoe UI",Roboto,Arial,sans-serif;color:#1d1e22;background:#e9e9ec;display:flex;align-items:center;justify-content:center;height:100vh}
.dlg{width:440px;background:#fff;border-radius:12px;box-shadow:0 24px 64px rgba(24,24,27,.18);padding:20px 22px}
h2{margin:0 0 4px;font-size:18px;letter-spacing:-.01em}.sub{color:#62626a;margin:0 0 16px;font-size:13px}
.row{display:flex;gap:8px;margin-bottom:12px}.inp{flex:1;border:1px solid #d4d4d8;border-radius:6px;padding:8px 10px;color:#3f3f46;font-size:13px;background:#fafafa}
.btn{border-radius:6px;padding:8px 14px;font-weight:600;font-size:13px;border:1px solid #d4d4d8;background:#fff}.pri{background:#1d1e22;color:#fff;border-color:#1d1e22}
.p{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid #eee}.av{width:28px;height:28px;border-radius:50%;color:#fff;font-weight:700;font-size:12px;display:flex;align-items:center;justify-content:center}
.sel{margin-left:auto;font-size:12.5px;color:#3f3f46;border:1px solid #e4e4e7;border-radius:6px;padding:4px 8px}.foot{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.seg{display:flex;border:1px solid #d4d4d8;border-radius:7px;overflow:hidden;margin-bottom:14px}.seg span{flex:1;text-align:center;padding:7px;font-size:12.5px}.seg .on{background:#1d1e22;color:#fff}
.note{font-size:12px;color:#62626a;background:#f4f4f5;border-radius:6px;padding:8px 10px}`;
const people = (rows) => rows.map(([i, c, n, r]) => `<div class="p"><div class="av" style="background:${c}">${i}</div><div><b>${n}</b></div><div class="sel">${r} ▾</div></div>`).join("");

const shots = {
  "share-before": `<div class="dlg"><h2>Share</h2><p class="sub">Invite people to this note.</p>
    <div class="row"><div class="inp">Email address</div><div class="btn pri">Invite</div></div>
    ${people([["JR", "#296d9a", "James R.", "Owner"], ["AK", "#8e4ec6", "Aiko K.", "Can edit"]])}
    <div class="foot"><div class="btn">Copy link</div><div class="btn pri">Done</div></div></div>`,
  "share-after": `<div class="dlg"><h2>Share “Launch plan”</h2><p class="sub">People with access can see every note in this workspace.</p>
    <div class="seg"><span class="on">Invite people</span><span>Anyone with the link</span></div>
    <div class="row"><div class="inp">Name or email</div><div class="btn pri">Invite</div></div>
    ${people([["JR", "#296d9a", "James R.", "Owner"], ["AK", "#8e4ec6", "Aiko K.", "Can edit"], ["MT", "#2f9e44", "Mo T.", "Can view"]])}
    <div class="note">Agents you connect act as you and can edit too.</div>
    <div class="foot"><div class="btn">Copy link</div><div class="btn pri">Done</div></div></div>`,
  "share-mobile": `<div class="dlg" style="width:300px"><h2>Share</h2><div class="seg"><span class="on">People</span><span>Link</span></div>
    <div class="row"><div class="inp">Name or email</div></div><div class="btn pri" style="text-align:center;margin-bottom:10px">Invite</div>
    ${people([["JR", "#296d9a", "James", "Owner"], ["AK", "#8e4ec6", "Aiko", "Edit"]])}</div>`,
  "share-link": `<div class="dlg"><h2>Share “Launch plan”</h2><p class="sub">Anyone with the link can view. Sign-in required to edit.</p>
    <div class="seg"><span>Invite people</span><span class="on">Anyone with the link</span></div>
    <div class="row"><div class="inp">https://grimnotes.app/s/7fq2-launch-plan</div><div class="btn">Copy</div></div>
    <div class="p"><div>Link access</div><div class="sel">Can view ▾</div></div>
    <div class="p"><div>Expires</div><div class="sel">In 7 days ▾</div></div>
    <div class="foot"><div class="btn" style="color:#c62f28">Turn off link</div><div class="btn pri">Done</div></div></div>`,
};
for (const [name, body] of Object.entries(shots)) {
  await page.setContent(`<style>${css}</style>${body}`);
  await page.screenshot({ path: join(out, name + ".png") });
}
await browser.close();
console.log("wrote", Object.keys(shots).length, "images to", out);
