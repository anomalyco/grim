// Run in a page using the kit (Grim for Mac's --webpanel-selftest --webpanel-js=…): draws on the first diff and the
// first screenshot with synthetic pointer events, pins a comment, answers the question, then presses Send.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 100 && !(window.grimReview && document.querySelector("grim-diff-stack .gs-item")); i++) await wait(50);
  await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
  const fire = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true, isPrimary: true, pointerType: "mouse" }));
  const draw = (el, pts) => { fire(el, "pointerdown", ...pts[0]); for (const p of pts.slice(1)) fire(el, "pointermove", ...p); fire(el, "pointerup", ...pts[pts.length - 1]); };
  grimReview.setAnnotating(true);
  // a red ellipse around new lines 13-15 of the first file
  const diff = document.querySelector("grim-diff-stack grim-diff");
  const row = diff.querySelector('.gd-row[data-n="14"]');
  row.scrollIntoView({ block: "center" });
  await wait(100);
  let r = row.getBoundingClientRect();
  const layer = diff.querySelector(".gr-layer");
  const cx = r.left + 230, cy = r.top + r.height / 2, pts = [];
  for (let a = 0; a <= 360; a += 15) pts.push([cx + 140 * Math.cos((a * Math.PI) / 180), cy + 34 * Math.sin((a * Math.PI) / 180)]);
  draw(layer, pts);
  // a comment pinned on line 20
  grimReview.setTool("comment");
  r = diff.querySelector('.gd-row[data-n="20"]').getBoundingClientRect();
  fire(layer, "pointerdown", r.left + 380, r.top + 10);
  fire(layer, "pointerup", r.left + 380, r.top + 10);
  await wait(50);
  document.querySelector(".gr-editor textarea").value = "150 ms feels slow for local search; try 80?";
  [...document.querySelectorAll(".gr-editor button")].find((b) => b.textContent === "Save").click();
  // a highlighter stroke on the first screenshot
  grimReview.setTool("hl");
  const tile = document.querySelector(".gi-tile .gi-frame");
  tile.scrollIntoView({ block: "center" });
  await wait(100);
  r = tile.getBoundingClientRect();
  const tl = tile.querySelector(".gr-layer"), hp = [];
  for (let i = 0; i <= 10; i++) hp.push([r.left + r.width * (0.3 + 0.04 * i), r.top + r.height * 0.47]);
  draw(tl, hp);
  const q = document.querySelector("grim-note.gn-question .gn-answer");
  if (q) { q.value = "7 days, shown in the dialog."; q.dispatchEvent(new Event("input")); }
  diff.querySelector('.gd-row[data-n="10"]').scrollIntoView({ block: "start" });
  window.scrollBy(0, -60);
  await wait(100);
  document.documentElement.dataset.anns = grimReview.state().anns.length;
  await grimReview.send();
  // after the send (which clears what went): another stroke, left on the page for the snapshot
  await new Promise((r) => setTimeout(r, 300));
  grimReview.setTool("pen");
  tile.scrollIntoView({ block: "center" });
  await wait(100);
  r = tile.getBoundingClientRect();
  const ring = [];
  for (let a = 0; a <= 360; a += 20) ring.push([r.left + r.width * 0.5 + r.width * 0.3 * Math.cos((a * Math.PI) / 180), r.top + r.height * 0.5 + r.height * 0.2 * Math.sin((a * Math.PI) / 180)]);
  draw(tl, ring);
})().catch((e) => { document.title = "error " + e; });
