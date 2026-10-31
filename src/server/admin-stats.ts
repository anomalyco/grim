// The owner's live dashboard of launch metrics (metrics.ts): /admin/stats (the page), /admin/stats.js (its script) and
// GET /api/admin/stats (the numbers, polled every 5 s). Only for ADMIN_EMAILS (metrics.ts isAdmin); everyone else gets
// a plain 404, as for any unknown path. Linked from nowhere.
import { json } from "./api.ts";
import { adminStats, isAdmin } from "./metrics.ts";
import type { User } from "./auth.ts";
import type { Db } from "./seams/db.ts";
import { PATH as MARK_PATH, VIEW as MARK_VIEW } from "../shared/mark.ts";

const notFound = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

const PAGE_HEADERS = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function isAdminPath(p: string): boolean {
  return p === "/admin/stats" || p === "/admin/stats.js" || p === "/api/admin/stats" || p.startsWith("/admin/");
}

/** /admin/*, /api/admin/stats: the dashboard for an admin, else 404. */
export async function handleAdmin(db: Db, req: Request, p: string, user: User | null): Promise<Response> {
  if (!isAdmin(user) || (req.method !== "GET" && req.method !== "HEAD")) return notFound();
  if (p === "/api/admin/stats") return json(await adminStats(db), 200, { "x-robots-tag": "noindex" });
  if (p === "/admin/stats") return new Response(req.method === "HEAD" ? null : PAGE, { headers: { "content-type": "text/html; charset=utf-8", ...PAGE_HEADERS } });
  if (p === "/admin/stats.js") return new Response(req.method === "HEAD" ? null : SCRIPT, { headers: { "content-type": "text/javascript; charset=utf-8", ...PAGE_HEADERS } });
  return notFound();
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Grim · stats</title>
<style>
@font-face{font-family:"Inter";font-style:normal;font-weight:100 900;font-display:swap;src:url("/dist/fonts/Inter-roman-latin.woff2") format("woff2")}
:root{--paper:#fcfcfb;--ink:#1d1e22;--muted:#62626a;--grey:#8b8b93;--line:rgba(24,24,27,.12);--line-soft:rgba(24,24,27,.07);--tint:#f1f1f2;--blue:#296d9a;--green:#2f7d4f;
--font:-apple-system,BlinkMacSystemFont,"Inter",system-ui,"Segoe UI",Roboto,Arial,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
*{box-sizing:border-box}
html,body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.45 var(--font);-webkit-font-smoothing:antialiased}
main{max-width:1180px;margin:0 auto;padding:28px 28px 64px}
header{display:flex;align-items:center;gap:14px;margin-bottom:26px}
.logo{display:flex;align-items:center;gap:9px;font-weight:800;letter-spacing:.04em;font-size:15px}
.logo svg{height:16px;width:auto}
.logo .sub{font-weight:500;letter-spacing:0;color:var(--muted)}
.cfwa{margin-left:auto;font-size:12.5px}.feed .cc{color:var(--muted);font-size:12px}
.live{margin-left:18px;display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12.5px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 0 rgba(47,125,79,.5);animation:pulse 2s infinite}
.paused .dot{background:var(--grey);animation:none}.stale .dot{background:#c62f28;animation:none}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(47,125,79,.45)}70%{box-shadow:0 0 0 7px rgba(47,125,79,0)}100%{box-shadow:0 0 0 0 rgba(47,125,79,0)}}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
h2{font-size:12px;font-weight:600;color:var(--muted);margin:30px 0 10px;letter-spacing:.005em}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
@media (max-width:900px){.tiles{grid-template-columns:repeat(2,1fr)}.cols{grid-template-columns:1fr!important}}
.tile{border:1px solid var(--line);border-radius:8px;padding:14px 16px 10px;background:#fff;position:relative;transition:background .6s}
.tile.bump{background:#f3f8f4;transition:none}
.tile .label{font-size:12.5px;color:var(--muted);font-weight:500}
.tile .big{font-size:38px;font-weight:650;letter-spacing:-.02em;line-height:1.1;margin-top:6px;font-variant-numeric:tabular-nums}
.tile .all{font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.tile .all b{color:var(--ink);font-weight:600}
.tile svg{display:block;width:100%;height:34px;margin-top:10px}
.bar{fill:var(--ink);opacity:.18}.bar.last{opacity:.85}
.funnel{display:flex;align-items:stretch;gap:0;border:1px solid var(--line);border-radius:8px;background:#fff;overflow:hidden}
.step{flex:1;padding:14px 18px}.step+.step{border-left:1px solid var(--line-soft)}
.step .n{font-size:24px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.step .l{font-size:12.5px;color:var(--muted)}
.step .pct{font-size:12.5px;color:var(--green);font-weight:600;margin-left:6px}
.step .t{font-size:12px;color:var(--grey);font-variant-numeric:tabular-nums}
.cols{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:20px}
.panel{border:1px solid var(--line);border-radius:8px;background:#fff;padding:6px 0;min-height:60px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
td,th{padding:5px 14px;text-align:right;font-size:13px}
th{font-weight:500;color:var(--grey);font-size:11.5px}
td:first-child,th:first-child{text-align:left;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
tr+tr td{border-top:1px solid var(--line-soft)}
.empty{color:var(--grey);padding:10px 14px;font-size:13px}
.feed{list-style:none;margin:0;padding:0;max-height:420px;overflow:auto}
.feed li{display:flex;gap:10px;padding:5px 14px;font-size:13px;align-items:baseline}
.feed li+li{border-top:1px solid var(--line-soft)}
.feed .ev{font-family:var(--mono);font-size:12px}
.feed .ago{margin-left:auto;color:var(--grey);font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}
.feed li.new{animation:flash 1.6s ease-out}
@keyframes flash{from{background:#eaf4ed}to{background:transparent}}
.hours svg{display:block;width:100%;height:90px}
.hours .axis{fill:var(--grey);font-size:10px}
.minor{display:grid;grid-template-columns:repeat(4,1fr);gap:8px 20px;font-size:13px}
.minor div{display:flex;justify-content:space-between;border-bottom:1px solid var(--line-soft);padding:4px 0;font-variant-numeric:tabular-nums}
.minor span{color:var(--muted)}
footer{margin-top:34px;color:var(--grey);font-size:12px}
</style></head>
<body><main>
<header>
  <div class="logo"><svg viewBox="${MARK_VIEW}" fill="currentColor" aria-hidden="true"><path d="${MARK_PATH}"/></svg>GRIM <span class="sub">launch stats</span></div>
  <a class="cfwa" href="https://dash.cloudflare.com/?to=/:account/web-analytics" target="_blank" rel="noopener">Web Analytics ↗</a>
  <div class="live" id="live"><span class="dot"></span><span id="updated">loading…</span></div>
</header>
<section class="tiles" id="tiles"></section>
<h2>Conversion</h2>
<div class="funnel" id="funnel"></div>
<h2>Last 24 hours, by hour</h2>
<div class="panel hours" id="hours"></div>
<div class="cols">
  <div><h2>Top referrers (30 days)</h2><div class="panel" id="refs"></div></div>
  <div><h2>Top countries (30 days)</h2><div class="panel" id="countries"></div></div>
  <div><h2>Live feed</h2><div class="panel"><ul class="feed" id="feed"></ul></div></div>
</div>
<h2>Everything else (today / all-time)</h2>
<div class="minor" id="minor"></div>
<footer>Counts only: no cookies, no IPs, no user data (docs/README.md "Metrics"). Times are UTC days. Page traffic: <a href="https://dash.cloudflare.com/?to=/:account/web-analytics" target="_blank" rel="noopener">Cloudflare Web Analytics</a>.</footer>
</main><script src="/admin/stats.js"></script></body></html>`;

// The page's script: plain ES2017, no libraries; numbers tween to their new values, charts are hand-made SVG.
const SCRIPT = String.raw`(function () {
"use strict";
var TILES = [
  ["signup", "Signups"], ["workspace_created", "Workspaces created"], ["demo_opened", "Demo opens"], ["landing_view", "Landing views"],
  ["get_started_click", "Get started clicks"], ["agent_command", "Agent commands"], ["mcp_connected", "MCP connections"], ["mac_download", "Mac downloads"]
];
var MINOR = [
  ["signin", "Sign-ins"], ["personal_workspace_created", "Personal workspaces"], ["note_created", "Notes created (API)"],
  ["mcp_command", "MCP commands"], ["mac_download_click", "Mac download clicks"], ["mac_download_confirm", "Mac download confirms"], ["account_deleted", "Accounts deleted"]
];
var SVGNS = "http://www.w3.org/2000/svg";
var shown = {};
var lastFeed = 0;
var data = null;
var timer = null;
var failures = 0;
var fmt = new Intl.NumberFormat("en");

function el(tag, attrs, kids) {
  var e = tag.indexOf("svg:") === 0 ? document.createElementNS(SVGNS, tag.slice(4)) : document.createElement(tag);
  for (var k in attrs || {}) {
    if (k === "text") e.textContent = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
  return e;
}

/** A number that tweens from what it showed to "value". */
function animate(node, key, value) {
  var from = shown[key];
  shown[key] = value;
  if (from === undefined || from === value) { node.textContent = fmt.format(value); return false; }
  var start = performance.now();
  var dur = 700;
  function step(t) {
    var k = Math.min(1, (t - start) / dur);
    var ease = 1 - Math.pow(1 - k, 3);
    node.textContent = fmt.format(Math.round(from + (value - from) * ease));
    if (k < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
  return true;
}

function bars(values, w, h, gap) {
  var svg = el("svg:svg", { viewBox: "0 0 " + w + " " + h, preserveAspectRatio: "none" });
  var max = Math.max.apply(null, values.concat([1]));
  var bw = w / values.length;
  values.forEach(function (v, i) {
    var bh = v ? Math.max(1.5, (v / max) * (h - 2)) : 0.75;
    var r = el("svg:rect", { x: (i * bw + gap / 2).toFixed(2), y: (h - bh).toFixed(2), width: Math.max(0.5, bw - gap).toFixed(2), height: bh.toFixed(2), class: "bar" + (i === values.length - 1 ? " last" : "") });
    r.appendChild(el("svg:title", { text: String(v) }));
    svg.appendChild(r);
  });
  return svg;
}

function buildTiles() {
  var host = document.getElementById("tiles");
  TILES.forEach(function (t) {
    host.appendChild(el("div", { class: "tile", id: "tile-" + t[0] }, [
      el("div", { class: "label", text: t[1] + " today" }),
      el("div", { class: "big", id: "big-" + t[0], text: "–" }),
      el("div", { class: "all" }, [el("b", { id: "all-" + t[0], text: "–" }), document.createTextNode(" all-time")]),
      el("div", { id: "spark-" + t[0] })
    ]));
  });
  var minor = document.getElementById("minor");
  MINOR.forEach(function (t) {
    minor.appendChild(el("div", {}, [el("span", { text: t[1] }), el("b", { id: "minor-" + t[0], text: "–" })]));
  });
}

function renderTiles(d) {
  TILES.forEach(function (t) {
    var e = d.events[t[0]];
    if (!e) return;
    var bumped = animate(document.getElementById("big-" + t[0]), "today:" + t[0], e.today);
    animate(document.getElementById("all-" + t[0]), "all:" + t[0], e.total);
    var spark = document.getElementById("spark-" + t[0]);
    spark.replaceChildren(bars(e.days.slice(-14), 280, 34, 3));
    spark.title = "Last 14 days: " + e.days.slice(-14).join(", ");
    if (bumped) {
      var tile = document.getElementById("tile-" + t[0]);
      tile.classList.add("bump");
      setTimeout(function () { tile.classList.remove("bump"); }, 60);
    }
  });
  MINOR.forEach(function (t) {
    var e = d.events[t[0]];
    if (e) document.getElementById("minor-" + t[0]).textContent = fmt.format(e.today) + " / " + fmt.format(e.total);
  });
}

function pct(a, b) { return b ? (100 * a / b).toFixed(b && a / b < 0.1 ? 1 : 0) + "%" : "–"; }

function renderFunnel(d) {
  var steps = [["landing_view", "Landing views"], ["get_started_click", "Get started"], ["signup", "Signups"]];
  var host = document.getElementById("funnel");
  host.replaceChildren();
  steps.forEach(function (s, i) {
    var e = d.events[s[0]];
    var prev = i ? d.events[steps[i - 1][0]] : null;
    var n = el("span", { class: "n", text: fmt.format(e.today) });
    var head = el("div", {}, [n, prev ? el("span", { class: "pct", text: pct(e.today, prev.today) }) : null]);
    host.appendChild(el("div", { class: "step" }, [
      head,
      el("div", { class: "l", text: s[1] + " today" }),
      el("div", { class: "t", text: "all-time " + fmt.format(e.total) + (prev ? " · " + pct(e.total, prev.total) : "") })
    ]));
  });
}

function renderHours(d) {
  var host = document.getElementById("hours");
  var w = 1000, h = 90, pad = 14;
  var svg = el("svg:svg", { viewBox: "0 0 " + w + " " + h, preserveAspectRatio: "none" });
  var series = [["landing_view", "var(--ink)", 0.22], ["demo_opened", "var(--blue)", 0.55], ["signup", "var(--green)", 0.95]];
  var max = 1;
  series.forEach(function (s) { max = Math.max.apply(null, [max].concat(d.events[s[0]].hours)); });
  var bw = w / 24;
  series.forEach(function (s, si) {
    d.events[s[0]].hours.forEach(function (v, i) {
      if (!v) return;
      var bh = Math.max(1.5, (v / max) * (h - pad - 4));
      var sub = bw / 3;
      var r = el("svg:rect", { x: (i * bw + si * sub + 2).toFixed(1), y: (h - pad - bh).toFixed(1), width: (sub - 3).toFixed(1), height: bh.toFixed(1), fill: s[1], "fill-opacity": s[2] });
      r.appendChild(el("svg:title", { text: s[0] + " " + new Date(d.hours[i]).getUTCHours() + ":00 UTC: " + v }));
      svg.appendChild(r);
    });
  });
  d.hours.forEach(function (t, i) {
    if (i % 3) return;
    var hr = new Date(t).getHours();
    svg.appendChild(el("svg:text", { x: (i * bw + 2).toFixed(1), y: h - 2, class: "axis", text: (hr < 10 ? "0" : "") + hr + ":00" }));
  });
  var legend = el("div", { style: "display:flex;gap:16px;padding:4px 14px 2px;font-size:12px;color:var(--muted)" });
  [["Landing views", "rgba(29,30,34,.3)"], ["Demo opens", "rgba(41,109,154,.6)"], ["Signups", "var(--green)"]].forEach(function (l) {
    legend.appendChild(el("span", {}, [el("span", { style: "display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;background:" + l[1] }), document.createTextNode(l[0])]));
  });
  host.replaceChildren(legend, el("div", { style: "padding:0 10px" }, [svg]));
}

function table(host, head, rows) {
  if (!rows.length) { host.replaceChildren(el("div", { class: "empty", text: "Nothing yet" })); return; }
  var t = el("table", {}, [el("tr", {}, head.map(function (x) { return el("th", { text: x }); }))]);
  rows.forEach(function (r) { t.appendChild(el("tr", {}, r.map(function (x) { return el("td", { text: typeof x === "number" ? fmt.format(x) : x }); }))); });
  host.replaceChildren(t);
}

function ago(t, now) {
  var s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return s + " s ago";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return new Date(t).toLocaleDateString();
}

function renderFeed(d) {
  var host = document.getElementById("feed");
  var newest = d.recent.length ? d.recent[0].at : 0;
  host.replaceChildren();
  if (!d.recent.length) { host.appendChild(el("li", { class: "empty", text: "No events yet" })); return; }
  d.recent.forEach(function (r) {
    host.appendChild(el("li", { class: lastFeed && r.at > lastFeed ? "new" : "" }, [
      el("span", { class: "ev", text: r.event }),
      el("span", { class: "cc", text: r.country || "" }),
      el("span", { class: "ago", text: ago(r.at, d.now), title: new Date(r.at).toLocaleString() })
    ]));
  });
  lastFeed = Math.max(lastFeed, newest);
}

function render(d) {
  data = d;
  renderTiles(d);
  renderFunnel(d);
  renderHours(d);
  table(document.getElementById("refs"), ["Site", "Views", "Signups", "Today"], d.referrers.map(function (r) { return [r.host, r.views, r.signups, r.today]; }));
  table(document.getElementById("countries"), ["Country", "Views", "Signups", "Events"], d.countries.map(function (r) { return [r.country, r.views, r.signups, r.events]; }));
  renderFeed(d);
  var live = document.getElementById("live");
  live.className = "live" + (d.metrics ? "" : " stale");
  document.getElementById("updated").textContent = (d.metrics ? "Live · updated " : "METRICS=off · updated ") + new Date().toLocaleTimeString();
}

function poll() {
  clearTimeout(timer);
  timer = null;
  if (document.hidden) return;
  fetch("/api/admin/stats", { cache: "no-store", credentials: "same-origin" })
    .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then(function (d) { failures = 0; render(d); })
    .catch(function (e) {
      failures++;
      document.getElementById("live").className = "live stale";
      document.getElementById("updated").textContent = "Couldn't update (" + e.message + ")" + (data ? " · last data shown" : "");
    })
    .then(function () { if (!document.hidden) timer = setTimeout(poll, failures ? Math.min(60000, 5000 * failures) : 5000); });
}

document.addEventListener("visibilitychange", function () {
  if (document.hidden) {
    clearTimeout(timer);
    timer = null;
    document.getElementById("live").className = "live paused";
    document.getElementById("updated").textContent = "Paused (tab hidden)";
  } else poll();
});

buildTiles();
poll();
})();
`;
