/* Grim review kit: <grim-diff>, <grim-diff-stack>, <grim-images>, <grim-compare>, <grim-section>,
   <grim-note>, <grim-checklist>, <grim-video>, plus drawing annotations sent back to the agent session.
   No build step. Include with <script src="/_kit/review.js"></script>; review.css is loaded next to it. */
(() => {
  'use strict';
  if (window.grimReview) return;
  const VERSION = 1;
  const SCRIPT = document.currentScript;

  // ---------- small helpers ----------
  const h = (tag, a, ...kids) => {
    const e = document.createElement(tag);
    if (a) for (const k in a) {
      const v = a[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
    return e;
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const absUrl = (src, base) => new URL(src, base || document.baseURI).href;
  async function fetchText(src, base) {
    const r = await fetch(absUrl(src, base));
    if (!r.ok) throw new Error(`Couldn't load ${src} (${r.status})`);
    return r.text();
  }
  const domReady = () => document.readyState === 'loading'
    ? new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true })) : Promise.resolve();
  const frame = () => new Promise(r => requestAnimationFrame(() => r()));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const r4 = n => Math.round(n * 10000) / 10000;
  const r1 = n => Math.round(n * 10) / 10;
  const baseName = p => String(p).split(/[\\/]/).pop();
  function dedent(s) {
    s = s.replace(/\r\n/g, '\n').replace(/^[ \t]*\n/, '').replace(/\n[ \t]*$/, '');
    const ind = s.split('\n').filter(l => l.trim()).map(l => l.match(/^[ \t]*/)[0].length);
    const min = ind.length ? Math.min(...ind) : 0;
    return min ? s.split('\n').map(l => l.slice(min)).join('\n') : s;
  }
  const I = {
    pen: '<svg viewBox="0 0 20 20"><path d="M4 16l1-4 8.5-8.5a2.1 2.1 0 013 3L8 15l-4 1z"/></svg>',
    hl: '<svg viewBox="0 0 20 20"><path d="M6 14l-2 3h5l1-1.5M6 14l7.5-9.5 3 3L7 15z"/><path d="M3 18h14" stroke-opacity=".4" stroke-width="2.5"/></svg>',
    comment: '<svg viewBox="0 0 20 20"><path d="M4 4h12v9H9l-4 3v-3H4z"/></svg>',
    undo: '<svg viewBox="0 0 20 20"><path d="M7 5L3.5 8.5 7 12M4 8.5h8a4 4 0 010 8h-2"/></svg>',
    trash: '<svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10"/></svg>',
    list: '<svg viewBox="0 0 20 20"><path d="M7 5h10M7 10h10M7 15h10M3.5 5h.01M3.5 10h.01M3.5 15h.01"/></svg>',
    send: '<svg viewBox="0 0 20 20"><path d="M3 10l14-6-5 13-2.5-5.5zM9.5 11.5L17 4"/></svg>',
    close: '<svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg>',
    chev: '<svg viewBox="0 0 20 20"><path d="M7 5l5 5-5 5"/></svg>',
    expand: '<svg viewBox="0 0 20 20"><path d="M11 4h5v5M9 16H4v-5M16 4l-5 5M4 16l5-5"/></svg>',
    left: '<svg viewBox="0 0 20 20"><path d="M12 4l-6 6 6 6"/></svg>',
    right: '<svg viewBox="0 0 20 20"><path d="M8 4l6 6-6 6"/></svg>',
  };
  const icon = n => h('span', { class: 'gr-ico', html: I[n] });

  // load the CSS beside the script, once
  if (SCRIPT && SCRIPT.src && !document.querySelector('link[data-grim-review]')) {
    document.head.append(h('link', { rel: 'stylesheet', href: SCRIPT.src.replace(/\.js(\?.*)?$/, '.css$1'), 'data-grim-review': '' }));
  }

  const bridge = () => window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.grim;

  // ---------- state (persisted per artifact) ----------
  const KEY = 'grim-review:' + location.origin + location.pathname;
  const fresh = () => ({ v: VERSION, anns: [], seq: 0, overall: '', answers: {}, checks: {}, viewed: {} });
  let state = fresh();
  try { Object.assign(state, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch {}
  // kept in the page's storage, and by Grim when the page runs in its panel (whose storage lasts only while it runs)
  let hostSaveTimer = null;
  const save = () => {
    state.t = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
    if (!bridge()) return;
    clearTimeout(hostSaveTimer);
    hostSaveTimer = setTimeout(() => { try { bridge().postMessage(JSON.stringify({ type: 'save', state })); } catch {} }, 400);
  };
  // Grim's copy, if newer than the page's
  function restore(s) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.anns) || (s.t || 0) <= (state.t || 0)) return;
    state = Object.assign(fresh(), s);
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
    emit();
    document.dispatchEvent(new CustomEvent('grim-review-restored'));
  }
  const undoStack = [];
  const listeners = new Set();
  const emit = () => listeners.forEach(f => f());
  function mutate(fn) {
    undoStack.push(JSON.stringify({ anns: state.anns, seq: state.seq }));
    if (undoStack.length > 200) undoStack.shift();
    fn(); save(); emit();
  }
  function undo() {
    const s = undoStack.pop();
    if (!s) return;
    Object.assign(state, JSON.parse(s)); save(); emit();
  }
  const ui = { annotating: false, tool: 'pen', color: '#e5484d', trayOpen: false, sending: false };
  const COLORS = ['#e5484d', '#f5a524', '#2f9e44', '#296d9a', '#8e4ec6'];
  const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem('grim-review:pref:' + k); localStorage.setItem('grim-review:pref:' + k, v); } catch {} };

  // ---------- surfaces: things that can be drawn on ----------
  const surfaces = new Map();
  const owners = new WeakMap();
  const baseCount = new Map();
  function registerSurface(owner, base, info) {
    let id = owners.get(owner);
    if (!id) {
      const n = (baseCount.get(base) || 0) + 1;
      baseCount.set(base, n);
      id = n > 1 ? `${base}~${n}` : base;
      owners.set(owner, id);
    }
    let s = surfaces.get(id);
    if (!s) { s = { id, views: new Set() }; surfaces.set(id, s); }
    Object.assign(s, info);
    return s;
  }
  const annsOf = id => state.anns.filter(a => a.s === id);
  // surface ids in document order (surfaces not on the page go last)
  function docOrder(ids) {
    const node = id => { const s = surfaces.get(id); const v = s && primaryView(s); return v ? v.host : null; };
    return ids.sort((a, b) => {
      const x = node(a), y = node(b);
      if (!x || !y) return (x ? 0 : 1) - (y ? 0 : 1);
      return x === y ? 0 : x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  }

  function pathD(p) {
    if (!p.length) return '';
    if (p.length === 1) return `M${p[0][0]} ${p[0][1]}L${p[0][0] + 0.01} ${p[0][1]}`;
    let d = `M${p[0][0]} ${p[0][1]}`;
    for (let i = 1; i < p.length - 1; i++) {
      d += `Q${p[i][0]} ${p[i][1]} ${(p[i][0] + p[i + 1][0]) / 2} ${(p[i][1] + p[i + 1][1]) / 2}`;
    }
    const l = p[p.length - 1];
    return d + `L${l[0]} ${l[1]}`;
  }
  const SVGNS = 'http://www.w3.org/2000/svg';

  // A View is one place a surface is shown (a diff body, a grid tile, the lightbox).
  // kind 'image': coordinates normalized to the image box. kind 'diff': x in px, y relative to an anchor row.
  class View {
    constructor(surf, host) {
      this.surf = surf; this.host = host;
      host.classList.add('gr-host');
      this.layer = h('div', { class: 'gr-layer' });
      this.svg = document.createElementNS(SVGNS, 'svg');
      this.svg.setAttribute('class', 'gr-svg');
      this.pins = h('div', { class: 'gr-pins' });
      this.layer.append(this.svg, this.pins);
      host.append(this.layer);
      surf.views.add(this);
      this.layer.addEventListener('pointerdown', e => this.down(e));
      this.ro = new ResizeObserver(() => this.redraw());
      this.ro.observe(host);
      this.redraw();
    }
    destroy() { this.ro.disconnect(); this.surf.views.delete(this); this.layer.remove(); }
    size() { return [this.host.clientWidth, this.host.clientHeight]; }
    local(e) { const r = this.host.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    // stored -> px
    toPx(a, pt) {
      if (this.surf.kind === 'image') { const [w, hh] = this.size(); return [pt[0] * w, pt[1] * hh]; }
      const top = this.rowTop(a.a);
      return top == null ? null : [pt[0], top + pt[1]];
    }
    widthPx(a) { return this.surf.kind === 'image' ? a.w * this.size()[0] : a.w; }
    rowTop(key) { const r = this.surf.rowEl && this.surf.rowEl(key); return r ? r.offsetTop : null; }
    redraw() {
      this.svg.textContent = ''; this.pins.textContent = '';
      for (const a of annsOf(this.surf.id)) {
        if (a.type === 'stroke') {
          const pts = a.pts.map(p => this.toPx(a, p));
          if (pts.some(p => !p)) continue;
          this.svg.append(strokeEl(pts, a.color, this.widthPx(a), a.tool));
        } else if (a.type === 'comment') {
          const p = this.toPx(a, [a.x, a.y]);
          if (!p) continue;
          const pin = h('button', { class: 'gr-pin', title: a.text, style: `left:${p[0]}px;top:${p[1]}px;background:${a.color}`, text: a.n });
          pin.addEventListener('pointerdown', e => e.stopPropagation());
          pin.addEventListener('click', e => { e.stopPropagation(); openEditor(this, a, pin); });
          this.pins.append(pin);
        }
      }
    }
    down(e) {
      if (!ui.annotating || e.button !== 0) return;
      e.preventDefault();
      const start = this.local(e);
      if (ui.tool === 'comment') {
        const up = ev => {
          this.layer.removeEventListener('pointerup', up);
          const p = this.local(ev);
          if (Math.hypot(p[0] - start[0], p[1] - start[1]) > 6) return;
          const c = this.store({ type: 'comment', color: ui.color }, [p]);
          if (c) openEditor(this, c, null, p);
        };
        this.layer.addEventListener('pointerup', up);
        return;
      }
      try { this.layer.setPointerCapture(e.pointerId); } catch {}
      const pts = [start];
      const w = ui.tool === 'hl' ? 16 : 2.5;
      const live = strokeEl(pts, ui.color, w, ui.tool);
      this.svg.append(live);
      const move = ev => {
        const co = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [];
        for (const ce of co.length ? co : [ev]) {
          const p = this.local(ce), l = pts[pts.length - 1];
          if (Math.hypot(p[0] - l[0], p[1] - l[1]) >= 1.5) pts.push(p);
        }
        live.setAttribute('d', pathD(pts));
      };
      const end = () => {
        this.layer.removeEventListener('pointermove', move);
        this.layer.removeEventListener('pointerup', end);
        this.layer.removeEventListener('pointercancel', end);
        live.remove();
        const a = this.store({ type: 'stroke', tool: ui.tool, color: ui.color, w }, pts);
        if (a) mutate(() => state.anns.push(a));
      };
      this.layer.addEventListener('pointermove', move);
      this.layer.addEventListener('pointerup', end);
      this.layer.addEventListener('pointercancel', end);
    }
    // px points -> stored annotation (not yet added)
    store(a, pts) {
      a.id = uid(); a.s = this.surf.id; a.t = Date.now();
      if (this.surf.kind === 'image') {
        const [w, hh] = this.size();
        if (!w || !hh) return null;
        const n = pts.map(p => [r4(p[0] / w), r4(p[1] / hh)]);
        if (a.type === 'comment') { a.x = n[0][0]; a.y = n[0][1]; } else { a.pts = n; a.w = r4(a.w / w); }
        return a;
      }
      const key = this.surf.rowAt && this.surf.rowAt(pts[0][1]);
      if (!key) return null;
      const top = this.rowTop(key);
      a.a = key;
      const n = pts.map(p => [r1(p[0]), r1(p[1] - top)]);
      if (a.type === 'comment') { a.x = n[0][0]; a.y = n[0][1]; } else a.pts = n;
      return a;
    }
  }
  function strokeEl(pts, color, w, tool) {
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', pathD(pts));
    p.setAttribute('stroke', color);
    p.setAttribute('stroke-width', w);
    p.setAttribute('class', tool === 'hl' ? 'gr-hl' : 'gr-pen');
    return p;
  }
  listeners.add(() => surfaces.forEach(s => s.views.forEach(v => v.redraw())));

  // ---------- comment editor popover ----------
  let editorEl = null;
  function closeEditor() { if (editorEl) { editorEl.remove(); editorEl = null; } }
  function openEditor(view, ann, pinEl, px) {
    closeEditor();
    const isNew = !state.anns.includes(ann);
    const ta = h('textarea', { rows: 3, placeholder: 'Comment for the agent…' });
    ta.value = ann.text || '';
    const saveIt = () => {
      const text = ta.value.trim();
      if (!text) { if (!isNew) mutate(() => state.anns = state.anns.filter(x => x !== ann)); closeEditor(); return; }
      mutate(() => { if (isNew) { ann.n = ++state.seq; ann.text = text; state.anns.push(ann); } else ann.text = text; });
      closeEditor();
    };
    editorEl = h('div', { class: 'gr-editor' },
      ta,
      h('div', { class: 'gr-editor-row' },
        !isNew && h('button', { class: 'gr-btn gr-btn-quiet', text: 'Delete', onclick: () => { mutate(() => state.anns = state.anns.filter(x => x !== ann)); closeEditor(); } }),
        h('span', { class: 'gr-grow' }),
        h('button', { class: 'gr-btn', text: 'Cancel', onclick: closeEditor }),
        h('button', { class: 'gr-btn gr-btn-primary', text: 'Save', onclick: saveIt })));
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveIt(); }
      if (e.key === 'Escape') { e.stopPropagation(); closeEditor(); }
    });
    document.body.append(editorEl);
    const hr = view.host.getBoundingClientRect();
    const p = pinEl ? pinEl.getBoundingClientRect() : { left: hr.left + px[0], bottom: hr.top + px[1] + 10 };
    const W = Math.min(300, innerWidth - 16);
    editorEl.style.width = W + 'px';
    editorEl.style.left = Math.max(8, Math.min(p.left - 12, innerWidth - W - 8)) + 'px';
    const top = p.bottom + 6;
    editorEl.style.top = (top + 130 > innerHeight ? Math.max(8, top - 170) : top) + 'px';
    ta.focus();
  }
  document.addEventListener('pointerdown', e => { if (editorEl && !editorEl.contains(e.target)) closeEditor(); }, true);

  // ---------- diff parsing ----------
  function splitLines(t) { t = String(t).replace(/\r\n/g, '\n'); if (t.endsWith('\n')) t = t.slice(0, -1); return t === '' ? [] : t.split('\n'); }
  function parsePatch(text, fallbackName) {
    const files = []; let f = null, hk = null;
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    const clean = p => { p = p.split('\t')[0].trim().replace(/^"|"$/g, ''); return p === '/dev/null' ? null : p.replace(/^[ab]\//, ''); };
    const start = (o, n) => { f = { oldPath: o, newPath: n, status: 'modified', hunks: [] }; files.push(f); hk = null; };
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (hk && (hk.ro > 0 || hk.rn > 0)) {
        const c = L[0];
        if (c === '\\') continue;
        if (c === '+') { hk.lines.push({ t: '+', s: L.slice(1) }); hk.rn--; continue; }
        if (c === '-') { hk.lines.push({ t: '-', s: L.slice(1) }); hk.ro--; continue; }
        if (c === ' ' || L === '') { hk.lines.push({ t: ' ', s: L.slice(1) }); hk.ro--; hk.rn--; continue; }
        hk = null;
      }
      let m;
      if ((m = /^diff --git a\/(.+?) b\/(.+)$/.exec(L))) { start(m[1], m[2]); continue; }
      if (L.startsWith('--- ') && lines[i + 1] && lines[i + 1].startsWith('+++ ')) {
        if (!f || f.hunks.length) start(null, null);
        f.oldPath = clean(L.slice(4)); f.newPath = clean(lines[i + 1].slice(4)); i++;
        if (!f.oldPath) f.status = 'added';
        if (!f.newPath) f.status = 'deleted';
        continue;
      }
      if ((m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(L))) {
        if (!f) start(fallbackName, fallbackName);
        hk = { o: +m[1], n: +m[3], ro: m[2] == null ? 1 : +m[2], rn: m[4] == null ? 1 : +m[4], ctx: m[5].trim(), lines: [] };
        f.hunks.push(hk); continue;
      }
      if (!f) continue;
      if (L.startsWith('new file mode')) f.status = 'added';
      else if (L.startsWith('deleted file mode')) f.status = 'deleted';
      else if (L.startsWith('rename from ')) { f.oldPath = L.slice(12); f.status = 'renamed'; }
      else if (L.startsWith('rename to ')) { f.newPath = L.slice(10); f.status = 'renamed'; }
      else if (L.startsWith('Binary files')) f.binary = true;
    }
    for (const x of files) finishFile(x);
    return files;
  }
  function finishFile(f) {
    f.oldPath = f.oldPath || f.newPath; f.newPath = f.newPath || f.oldPath;
    if (f.status === 'modified' && f.oldPath !== f.newPath) f.status = 'renamed';
    f.path = f.status === 'deleted' ? f.oldPath : f.newPath;
    f.add = 0; f.del = 0;
    for (const hk of f.hunks) {
      let o = hk.o, n = hk.n;
      hk.ro = hk.lines.filter(l => l.t !== '+').length; hk.rn = hk.lines.filter(l => l.t !== '-').length;
      for (const l of hk.lines) {
        if (l.t === ' ') { l.o = o++; l.n = n++; } else if (l.t === '-') { l.o = o++; f.del++; } else { l.n = n++; f.add++; }
      }
      markIntraline(hk.lines);
    }
    return f;
  }
  // Myers O(ND) line diff
  function diffLines(a, b) {
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let ea = a.length, eb = b.length;
    while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
    const A = a.slice(s, ea), B = b.slice(s, eb), N = A.length, M = B.length, max = N + M, off = max + 1;
    const mid = [];
    if (max) {
      const v = new Int32Array(2 * max + 3), trace = [];
      let done = false;
      for (let d = 0; d <= max && !done; d++) {
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
          let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
          let y = x - k;
          while (x < N && y < M && A[x] === B[y]) { x++; y++; }
          v[off + k] = x;
          if (x >= N && y >= M) { done = true; break; }
        }
      }
      let x = N, y = M;
      for (let d = trace.length - 1; d >= 0; d--) {
        const vv = trace[d], k = x - y;
        const pk = (k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1])) ? k + 1 : k - 1;
        const px = vv[off + pk], py = px - pk;
        while (x > px && y > py) { mid.push({ t: ' ', s: A[--x] }); y--; }
        if (d > 0) { if (x === px) mid.push({ t: '+', s: B[--y] }); else mid.push({ t: '-', s: A[--x] }); }
      }
      mid.reverse();
    }
    return [...a.slice(0, s).map(x => ({ t: ' ', s: x })), ...mid, ...a.slice(ea).map(x => ({ t: ' ', s: x }))];
  }
  function fromBeforeAfter(before, after, name, ctx) {
    const a = splitLines(before), b = splitLines(after);
    const ops = diffLines(a, b);
    let o = 1, n = 1;
    for (const l of ops) { if (l.t !== '+') l.o = o++; if (l.t !== '-') l.n = n++; }
    const changed = ops.map((l, i) => l.t !== ' ' ? i : -1).filter(i => i >= 0);
    const hunks = [];
    if (changed.length) {
      let i = 0;
      while (i < changed.length) {
        let s = Math.max(0, changed[i] - ctx), e = Math.min(ops.length - 1, changed[i] + ctx);
        while (i + 1 < changed.length && changed[i + 1] - ctx <= e + 1) { i++; e = Math.min(ops.length - 1, changed[i] + ctx); }
        i++;
        const lines = ops.slice(s, e + 1).map(l => ({ t: l.t, s: l.s }));
        const first = ops.slice(s, e + 1);
        const fo = first.find(l => l.o != null), fn = first.find(l => l.n != null);
        hunks.push({ o: fo ? fo.o : (ops[s - 1] ? ops[s - 1].o || 0 : 0), n: fn ? fn.n : 0, ctx: '', lines,
          ro: lines.filter(l => l.t !== '+').length, rn: lines.filter(l => l.t !== '-').length });
      }
    }
    const f = { oldPath: name, newPath: name, status: !a.length && b.length ? 'added' : a.length && !b.length ? 'deleted' : 'modified', hunks };
    return finishFile(f);
  }
  function markIntraline(lines) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].t !== '-') continue;
      let j = i; while (j < lines.length && lines[j].t === '-') j++;
      let k = j; while (k < lines.length && lines[k].t === '+') k++;
      const nd = j - i, na = k - j;
      for (let p = 0; p < Math.min(nd, na); p++) {
        const a = lines[i + p], b = lines[j + p];
        let pre = 0; while (pre < a.s.length && pre < b.s.length && a.s[pre] === b.s[pre]) pre++;
        let suf = 0; while (suf < a.s.length - pre && suf < b.s.length - pre && a.s[a.s.length - 1 - suf] === b.s[b.s.length - 1 - suf]) suf++;
        const ca = a.s.length - pre - suf, cb = b.s.length - pre - suf;
        if (pre + suf < 3 || ca > a.s.length * 0.7 || cb > b.s.length * 0.7) continue;
        a.x = [pre, a.s.length - suf]; b.x = [pre, b.s.length - suf];
      }
      i = k - 1;
    }
  }

  // ---------- cheap syntax colouring ----------
  const KW = {
    js: 'abstract as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of package private protected public readonly return set static super switch this throw true try type typeof undefined var void while with yield func guard struct protocol extension self nil import',
    rs: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err',
    py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield end do then begin module require',
    go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false',
    sh: 'if then else elif fi for while do done case esac function in return export local echo set unset true false',
    css: 'important',
    sql: 'select from where and or not insert into values update set delete create table alter drop index join left right inner outer on group by order having limit as null is in like local function end then if else return',
  };
  const EXT = { js: 'js', jsx: 'js', ts: 'js', tsx: 'js', mjs: 'js', cjs: 'js', swift: 'js', java: 'js', kt: 'js', c: 'js', h: 'js', cc: 'js', cpp: 'js', cs: 'js', dart: 'js', rs: 'rs', py: 'py', rb: 'py', go: 'go', sh: 'sh', bash: 'sh', zsh: 'sh', toml: 'sh', yml: 'sh', yaml: 'sh', ini: 'sh', css: 'css', scss: 'css', less: 'css', html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', md: 'md', markdown: 'md', json: 'json', sql: 'sql', lua: 'sql' };
  const RX = {};
  function langRx(lang) {
    if (RX[lang]) return RX[lang];
    const com = { js: '\\/\\/.*|\\/\\*.*?(?:\\*\\/|$)', rs: '\\/\\/.*|\\/\\*.*?(?:\\*\\/|$)', go: '\\/\\/.*|\\/\\*.*?(?:\\*\\/|$)', css: '\\/\\*.*?(?:\\*\\/|$)', py: '#.*', sh: '#.*', sql: '--.*', html: '<!--.*?(?:-->|$)', md: '^#{1,6} .*', json: '(?!)' }[lang] || '(?!)';
    const str = '"(?:\\\\.|[^"\\\\])*"?|\'(?:\\\\.|[^\'\\\\])*\'?|`(?:\\\\.|[^`\\\\])*`?';
    const tag = lang === 'html' ? '|(<\\/?[\\w:-]+|\\/?>)' : '|(?!)';
    RX[lang] = new RegExp(`(${com})|(${lang === 'md' ? '`[^`]*`' : str})|(\\b\\d[\\d_.]*(?:e[+-]?\\d+)?[a-z]*\\b|\\b0x[\\da-f]+\\b)${tag}|([A-Za-z_$][\\w$-]*)`, 'gi');
    return RX[lang];
  }
  const kwSets = {};
  function highlight(s, lang) {
    if (!lang || lang === 'text') return esc(s);
    const rx = langRx(lang);
    const kw = kwSets[lang] || (kwSets[lang] = new Set((KW[lang] || '').split(' ')));
    let out = '', last = 0, m;
    rx.lastIndex = 0;
    while ((m = rx.exec(s))) {
      if (m[0] === '') { rx.lastIndex++; continue; }
      out += esc(s.slice(last, m.index));
      const t = m[0];
      let cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : m[4] ? 'k' : null;
      if (!cls && m[5]) {
        if (kw.has(lang === 'sql' ? t.toLowerCase() : t)) cls = 'k';
        else if (lang === 'json' && (t === 'true' || t === 'false' || t === 'null')) cls = 'k';
        else if (s[m.index + t.length] === '(') cls = 'f';
        else if (/^[A-Z][a-z]/.test(t) && lang !== 'md') cls = 't';
      }
      out += cls ? `<span class="gh-${cls}">${esc(t)}</span>` : esc(t);
      last = m.index + t.length;
    }
    return out + esc(s.slice(last));
  }
  const langOf = (path, explicit) => explicit || EXT[(String(path || '').match(/\.([\w]+)$/) || [])[1]?.toLowerCase()] || 'text';
  function codeHtml(l, lang) {
    const s = l.s.replace(/\t/g, '    ');
    if (!l.x) return highlight(s, lang) || ' ';
    const [a, b] = [l.s.slice(0, l.x[0]).replace(/\t/g, '    ').length, l.s.slice(0, l.x[1]).replace(/\t/g, '    ').length];
    return highlight(s.slice(0, a), lang) + `<span class="gd-x">${highlight(s.slice(a, b), lang)}</span>` + highlight(s.slice(b), lang);
  }

  // ---------- diff rendering ----------
  function rowsHtml(file, mode, lang) {
    const out = [];
    file.hunks.forEach((hk, hi) => {
      const label = `@@ -${hk.o},${hk.ro} +${hk.n},${hk.rn} @@${hk.ctx ? ' ' + hk.ctx : ''}`;
      out.push(`<div class="gd-row gd-hunk" data-h="${hi}"><span class="gd-hunk-text">${esc(label)}</span></div>`);
      if (mode === 'unified') {
        for (const l of hk.lines) {
          const cls = l.t === '+' ? 'gd-add' : l.t === '-' ? 'gd-del' : 'gd-ctx';
          out.push(`<div class="gd-row ${cls}"${l.o != null ? ` data-o="${l.o}"` : ''}${l.n != null ? ` data-n="${l.n}"` : ''}><span class="gd-num">${l.o ?? ''}</span><span class="gd-num">${l.n ?? ''}</span><span class="gd-sign">${l.t === ' ' ? ' ' : l.t === '-' ? '−' : '+'}</span><span class="gd-code">${codeHtml(l, lang)}</span></div>`);
        }
        return;
      }
      const L = hk.lines;
      for (let i = 0; i < L.length;) {
        if (L[i].t === ' ') { out.push(splitRow(L[i], L[i], lang)); i++; continue; }
        let j = i; while (j < L.length && L[j].t === '-') j++;
        let k = j; while (k < L.length && L[k].t === '+') k++;
        for (let p = 0; p < Math.max(j - i, k - j); p++) out.push(splitRow(i + p < j ? L[i + p] : null, j + p < k ? L[j + p] : null, lang));
        i = k;
      }
    });
    return out.join('');
  }
  function splitRow(a, b, lang) {
    const ctx = a && a === b;
    const side = (l, which) => {
      if (!l) return `<span class="gd-num gd-empty"></span><span class="gd-code gd-empty"></span>`;
      const c = ctx ? '' : which === 'o' ? ' gd-del' : ' gd-add';
      return `<span class="gd-num${c}">${which === 'o' ? l.o : l.n}</span><span class="gd-code${c}">${codeHtml(l, lang)}</span>`;
    };
    return `<div class="gd-row gd-split${ctx ? ' gd-ctx' : ''}"${a ? ` data-o="${a.o}"` : ''}${b ? ` data-n="${b.n}"` : ''}>${side(a, 'o')}${side(b, 'n')}</div>`;
  }
  const STATUS = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R' };
  const modeDefault = () => pref('mode') || 'unified';

  class GrimDiff extends HTMLElement {
    connectedCallback() {
      if (this._init) return;
      this._init = true;
      this.ready = domReady().then(() => this._load()).catch(err => this._fail(err));
    }
    _fail(err) { this.textContent = ''; this.append(h('div', { class: 'gr-error', text: String(err && err.message || err) })); }
    async _load() {
      let file = this._file;
      const name = this.getAttribute('file');
      if (!file) {
        let text = null, before = null, after = null;
        const q = t => this.querySelector(`:scope > script[type="${t}"]`);
        const src = this.getAttribute('src');
        if (src) {
          const t = await fetchText(src, this._base);
          if (/\.json(\?|$)/i.test(src)) { const j = JSON.parse(t); text = j.diff ?? null; before = j.before ?? null; after = j.after ?? null; }
          else text = t;
        }
        if (this.getAttribute('before-src')) before = await fetchText(this.getAttribute('before-src'), this._base);
        if (this.getAttribute('after-src')) after = await fetchText(this.getAttribute('after-src'), this._base);
        if (q('text/x-before')) before = dedent(q('text/x-before').textContent);
        if (q('text/x-after')) after = dedent(q('text/x-after').textContent);
        const inl = q('text/x-diff') || q('text/x-patch') || this.querySelector(':scope > pre');
        if (inl) text = dedent(inl.textContent);
        if (text != null) {
          file = parsePatch(text, name || 'diff')[0];
          if (!file) throw new Error(`No diff found${name ? ' for ' + name : ''}`);
        } else if (before != null || after != null) {
          const ctx = this.getAttribute('context');
          file = fromBeforeAfter(before || '', after || '', name || 'file', ctx === 'all' ? 1e9 : +(ctx || 3));
        } else throw new Error('<grim-diff> needs src, before-src/after-src, or an inline diff');
      }
      if (name) file.display = name;
      this._file = file;
      const notes = [...this.querySelectorAll(':scope > grim-note')];
      if (this.getAttribute('note') || this._note) notes.unshift(h('grim-note', { text: this.getAttribute('note') || this._note }));
      this.textContent = '';
      this._render(notes);
    }
    get file() { return this._file; }
    _render(notes) {
      const f = this._file, display = f.display || f.path;
      this.lang = langOf(display, this.getAttribute('lang'));
      this.surf = registerSurface(this, 'diff:' + display, {
        kind: 'diff', label: display, file: display, el: this,
        rowEl: key => this.rowMap.get(key), rowAt: y => this.rowAt(y),
      });
      this.id = this.id || 'diff-' + this.surf.id.replace(/[^\w-]+/g, '-');
      const pathEl = h('span', { class: 'gd-path', title: display });
      if (f.status === 'renamed' && !f.display) pathEl.append(h('span', { class: 'gd-old', text: f.oldPath }), ' → ');
      const dir = display.includes('/') ? display.slice(0, display.lastIndexOf('/') + 1) : '';
      pathEl.append(h('span', { class: 'gd-dir', text: dir }), h('b', { text: display.slice(dir.length) }));
      this.viewedBox = h('input', { type: 'checkbox' });
      this.viewedBox.checked = !!state.viewed[this.surf.id];
      this.viewedBox.addEventListener('change', () => {
        state.viewed[this.surf.id] = this.viewedBox.checked; save();
        this.collapsed = this.viewedBox.checked;
        this.dispatchEvent(new CustomEvent('grim-viewed', { bubbles: true }));
      });
      this.seg = seg(['unified', 'split'], ['Unified', 'Split'], m => this.mode = m);
      this.badge = h('span', { class: 'gd-anns', hidden: true });
      const head = h('div', { class: 'gd-head' },
        h('button', { class: 'gd-toggle', 'aria-label': 'Collapse', html: I.chev, onclick: () => this.collapsed = !this.collapsed }),
        pathEl,
        f.status !== 'modified' && h('span', { class: `gd-badge gd-st-${f.status}`, text: f.status }),
        h('span', { class: 'gd-stat' }, h('span', { class: 'gd-plus', text: '+' + f.add }), ' ', h('span', { class: 'gd-minus', text: '−' + f.del })),
        this.badge,
        h('span', { class: 'gr-grow' }),
        h('label', { class: 'gd-viewed' }, this.viewedBox, 'Viewed'),
        this.seg.el);
      head.addEventListener('click', e => { if (e.target === head || e.target.closest('.gd-path')) this.collapsed = !this.collapsed; });
      this.body = h('div', { class: 'gd-body' });
      this.append(head);
      if (notes.length) this.append(h('div', { class: 'gd-notes' }, notes));
      this.append(this.body);
      this._mode = null;
      this.mode = this.getAttribute('mode') || (this.closest('grim-diff-stack')?.mode) || modeDefault();
      this.view = new View(this.surf, this.body);
      if (this.hasAttribute('collapsed') || state.viewed[this.surf.id]) this.collapsed = true;
      listeners.add(() => this._badge());
      this._badge();
    }
    _badge() {
      const n = annsOf(this.surf.id).length;
      this.badge.hidden = !n; this.badge.textContent = n + (n === 1 ? ' note' : ' notes');
    }
    get mode() { return this._mode; }
    set mode(m) {
      if (m !== 'split') m = 'unified';
      if (m === this._mode || !this._file) return;
      this._mode = m;
      this.seg.set(m);
      this.classList.toggle('gd-mode-split', m === 'split');
      const f = this._file;
      const layer = this.view && this.view.layer;
      this.body.innerHTML = f.binary ? '<div class="gd-msg">Binary file</div>' : f.hunks.length ? rowsHtml(f, m, this.lang) : '<div class="gd-msg">No changes</div>';
      if (layer) this.body.append(layer);
      const w = String(f.hunks.reduce((mx, hk) => Math.max(mx, hk.o + hk.ro, hk.n + hk.rn), 0)).length;
      this.body.style.setProperty('--gd-numw', Math.max(2, w) + 1 + 'ch');
      this.rows = [...this.body.querySelectorAll('.gd-row')];
      this.rowMap = new Map();
      for (const r of this.rows) {
        if (r.dataset.n) this.rowMap.set('n' + r.dataset.n, r);
        if (r.dataset.o && !this.rowMap.has('o' + r.dataset.o)) this.rowMap.set('o' + r.dataset.o, r);
        if (r.dataset.h) this.rowMap.set('h' + r.dataset.h, r);
      }
      if (this.view) this.view.redraw();
    }
    rowAt(y) {
      const rows = this.rows; if (!rows.length) return null;
      let lo = 0, hi = rows.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (rows[mid].offsetTop <= y) lo = mid; else hi = mid - 1; }
      return rowKey(rows[lo]);
    }
    get collapsed() { return this.classList.contains('gd-collapsed'); }
    set collapsed(v) {
      this.classList.toggle('gd-collapsed', !!v);
      if (this.view) requestAnimationFrame(() => this.view.redraw());
    }
  }
  const rowKey = r => r.dataset.n ? 'n' + r.dataset.n : r.dataset.o ? 'o' + r.dataset.o : r.dataset.h != null ? 'h' + r.dataset.h : null;

  function seg(values, labels, onpick) {
    const el = h('span', { class: 'gr-seg', role: 'group' });
    const btns = values.map((v, i) => h('button', { type: 'button', text: labels[i], onclick: e => { e.stopPropagation(); onpick(v); } }));
    el.append(...btns);
    return { el, set: v => btns.forEach((b, i) => b.classList.toggle('on', values[i] === v)) };
  }

  class GrimDiffStack extends HTMLElement {
    connectedCallback() {
      if (this._init) return;
      this._init = true;
      this.ready = domReady().then(() => this._load()).catch(err => { this.prepend(h('div', { class: 'gr-error', text: String(err.message || err) })); });
    }
    get mode() { return this._mode || this.getAttribute('mode') || modeDefault(); }
    async _load() {
      const items = [...this.querySelectorAll(':scope > grim-diff')];
      const pending = [];
      const src = this.getAttribute('src');
      const inl = this.querySelector(':scope > script[type="text/x-diff"], :scope > script[type="text/x-patch"]');
      if (src) {
        const base = absUrl(src);
        const t = await fetchText(src);
        if (/\.json(\?|$)/i.test(src)) {
          const j = JSON.parse(t);
          for (const it of (Array.isArray(j) ? j : j.files || [])) {
            const d = h('grim-diff', { file: it.file, 'before-src': it.beforeSrc, 'after-src': it.afterSrc, src: it.src, collapsed: !!it.collapsed, lang: it.lang });
            d._base = base;
            if (it.diff != null) d._file = parsePatch(it.diff, it.file || 'diff')[0] || fromBeforeAfter('', '', it.file, 3);
            else if (it.before != null || it.after != null) d._file = fromBeforeAfter(it.before || '', it.after || '', it.file || 'file', it.context === 'all' ? 1e9 : +(it.context || 3));
            if (it.note) d._note = it.note;
            pending.push(d);
          }
        } else for (const f of parsePatch(t)) { const d = h('grim-diff'); d._file = f; pending.push(d); }
      }
      if (inl) for (const f of parsePatch(dedent(inl.textContent))) { const d = h('grim-diff'); d._file = f; pending.push(d); }
      const diffs = [...items, ...pending];
      this._mode = this.getAttribute('mode') || modeDefault();
      this.toc = h('nav', { class: 'gs-toc' });
      this.statEl = h('span', { class: 'gs-stat' });
      this.modeSeg = seg(['unified', 'split'], ['Unified', 'Split'], m => { this._mode = m; pref('mode', m); this.modeSeg.set(m); diffs.forEach(d => d.mode = m); });
      this.modeSeg.set(this._mode);
      const filesBtn = h('button', { class: 'gr-btn gs-files', text: 'Files', onclick: () => this.classList.toggle('gs-toc-open') });
      const bar = h('div', { class: 'gs-bar' },
        h('span', { class: 'gs-title', text: this.getAttribute('heading') || 'Changes' }), this.statEl,
        h('span', { class: 'gr-grow' }), filesBtn,
        h('button', { class: 'gr-btn', text: 'Expand all', onclick: () => diffs.forEach(d => d.collapsed = false) }),
        h('button', { class: 'gr-btn', text: 'Collapse all', onclick: () => diffs.forEach(d => d.collapsed = true) }),
        this.modeSeg.el);
      const list = h('div', { class: 'gs-list' }, diffs);
      [...this.childNodes].forEach(n => { if (!diffs.includes(n)) n.remove(); });
      this.append(bar, h('div', { class: 'gs-wrap' }, this.toc, list));
      await Promise.all(diffs.map(d => d.ready));
      this.diffs = diffs.filter(d => d.file);
      let add = 0, del = 0;
      for (const d of this.diffs) { add += d.file.add; del += d.file.del; }
      this.statEl.innerHTML = `${this.diffs.length} file${this.diffs.length === 1 ? '' : 's'} <span class="gd-plus">+${add}</span> <span class="gd-minus">−${del}</span>`;
      this._toc();
      this.addEventListener('grim-viewed', () => this._toc());
      listeners.add(() => this._toc());
      const io = new IntersectionObserver(es => {
        for (const e of es) if (e.isIntersecting) {
          this.toc.querySelectorAll('.on').forEach(x => x.classList.remove('on'));
          this.toc.querySelector(`[data-for="${CSS.escape(e.target.id)}"]`)?.classList.add('on');
        }
      }, { rootMargin: '-50px 0px -70% 0px' });
      this.diffs.forEach(d => io.observe(d));
    }
    _toc() {
      if (!this.diffs) return;
      this.toc.textContent = '';
      for (const d of this.diffs) {
        const f = d.file, p = f.display || f.path, n = annsOf(d.surf.id).length;
        const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
        this.toc.append(h('button', {
          class: 'gs-item' + (state.viewed[d.surf.id] ? ' gs-viewed' : ''), 'data-for': d.id, title: p,
          onclick: () => { d.collapsed = false; this.classList.remove('gs-toc-open'); d.scrollIntoView({ block: 'start', behavior: 'smooth' }); },
        },
        h('span', { class: `gs-st gd-st-${f.status}`, text: STATUS[f.status] }),
        h('span', { class: 'gs-path' }, h('span', { class: 'gd-dir', text: dir }), p.slice(dir.length)),
        n ? h('span', { class: 'gs-n', text: n }) : null,
        h('span', { class: 'gs-pm' }, h('span', { class: 'gd-plus', text: '+' + f.add }), ' ', h('span', { class: 'gd-minus', text: '−' + f.del }))));
      }
    }
  }

  // ---------- images ----------
  function imageView(spec, key, img, frameEl) {
    const surf = registerSurface(spec, 'img:' + spec[key], { kind: 'image', label: spec.caption ? `${spec.caption}${spec.before ? (key === 'before' ? ' (before)' : ' (after)') : ''}` : baseName(spec[key]), src: spec[key] });
    if (!surf.img || !surf.img.isConnected) surf.img = img;
    const v = new View(surf, frameEl);
    img.addEventListener('load', () => v.redraw());
    return v;
  }
  // compare surfaces: one per side, owned by small per-side objects so ids stay stable
  function sideSpec(spec, key) { spec._sides = spec._sides || {}; return spec._sides[key] || (spec._sides[key] = { [key]: spec[key], caption: spec.caption, before: spec.before }); }

  function buildImageTile(spec, onOpen) {
    const img = h('img', { src: spec.src, alt: spec.caption || '', loading: 'lazy', draggable: 'false' });
    const fr = h('div', { class: 'gi-frame' }, img,
      h('button', { class: 'gi-zoom', title: 'Enlarge', html: I.expand, onclick: e => { e.stopPropagation(); onOpen(); } }));
    fr.addEventListener('click', () => { if (!ui.annotating) onOpen(); });
    const views = [imageView(spec, 'src', img, fr)];
    return { el: h('figure', { class: 'gi-tile' }, fr, spec.caption && h('figcaption', { text: spec.caption })), views };
  }
  function buildCompare(spec, large) {
    const root = h('figure', { class: 'gc' + (large ? ' gc-large' : '') });
    let views = [], pos = 50;
    const body = h('div', { class: 'gc-body' });
    const sg = seg(['side', 'swipe'], ['Side by side', 'Swipe'], m => render(m));
    root.append(h('div', { class: 'gc-head' }, h('span', { class: 'gc-cap', text: spec.caption || 'Before / after' }), h('span', { class: 'gr-grow' }),
      !large && h('button', { class: 'gr-btn gr-btn-icon', title: 'Enlarge', html: I.expand, onclick: () => spec._open && spec._open() }), sg.el), body);
    const render = m => {
      views.forEach(v => v.destroy()); views = [];
      spec.mode = m; sg.set(m); body.textContent = '';
      root.dataset.mode = m;
      if (m === 'side') {
        for (const key of ['before', 'after']) {
          const img = h('img', { src: spec[key], alt: key, draggable: 'false' });
          const fr = h('div', { class: 'gi-frame' }, img);
          body.append(h('div', { class: 'gc-side' }, h('div', { class: 'gc-label', text: spec[key + 'Label'] || (key === 'before' ? 'Before' : 'After') }), fr));
          views.push(imageView(sideSpec(spec, key), key, img, fr));
        }
        return;
      }
      const after = h('img', { src: spec.after, alt: 'after', draggable: 'false' });
      const before = h('img', { class: 'gc-before', src: spec.before, alt: 'before', draggable: 'false' });
      const handle = h('div', { class: 'gc-handle', tabindex: 0, role: 'slider', 'aria-label': 'Before/after position', 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span'));
      const fr = h('div', { class: 'gi-frame gc-swipe' }, after, before,
        h('span', { class: 'gc-tag gc-tag-l', text: spec.beforeLabel || 'Before' }), h('span', { class: 'gc-tag gc-tag-r', text: spec.afterLabel || 'After' }), handle);
      const set = p => {
        pos = Math.max(0, Math.min(100, p));
        before.style.clipPath = `inset(0 ${100 - pos}% 0 0)`;
        handle.style.left = pos + '%';
        handle.setAttribute('aria-valuenow', Math.round(pos));
        root.dataset.pos = Math.round(pos);
      };
      const drag = e => {
        if (ui.annotating && !e.target.closest('.gc-handle')) return;
        e.preventDefault(); e.stopPropagation();
        const r = fr.getBoundingClientRect();
        const mv = ev => set((ev.clientX - r.left) / r.width * 100);
        mv(e);
        const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
        addEventListener('pointermove', mv); addEventListener('pointerup', up);
      };
      fr.addEventListener('pointerdown', drag);
      handle.addEventListener('pointerdown', drag);
      handle.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') set(pos - 5); if (e.key === 'ArrowRight') set(pos + 5); });
      body.append(fr);
      set(pos);
      const v = imageView(sideSpec(spec, 'after'), 'after', after, fr);
      fr.append(handle);
      views.push(v);
    };
    render(spec.mode === 'swipe' ? 'swipe' : 'side');
    return { el: root, destroy: () => views.forEach(v => v.destroy()) };
  }

  let lightbox = null;
  function closeLightbox() { if (lightbox) { lightbox.destroy(); lightbox.el.remove(); lightbox = null; } }
  function openLightbox(list, i) {
    closeLightbox();
    const spec = list[i];
    let built;
    if (spec.before) built = buildCompare(spec, true);
    else {
      const img = h('img', { src: spec.src, alt: spec.caption || '', draggable: 'false' });
      const fr = h('div', { class: 'gi-frame' }, img);
      const v = imageView(spec, 'src', img, fr);
      built = { el: h('figure', { class: 'gl-fig' }, fr, spec.caption && h('figcaption', { text: spec.caption })), destroy: () => v.destroy() };
    }
    const nav = (d) => openLightbox(list, (i + d + list.length) % list.length);
    const el = h('div', { class: 'gr-lightbox', role: 'dialog' },
      h('button', { class: 'gl-close gr-btn gr-btn-icon', title: 'Close', html: I.close, onclick: closeLightbox }),
      list.length > 1 && h('button', { class: 'gl-nav gl-prev', html: I.left, onclick: () => nav(-1) }),
      h('div', { class: 'gl-stage' }, built.el),
      list.length > 1 && h('button', { class: 'gl-nav gl-next', html: I.right, onclick: () => nav(1) }),
      list.length > 1 && h('div', { class: 'gl-count', text: `${i + 1} / ${list.length}` }));
    el.addEventListener('click', e => { if (e.target === el) closeLightbox(); });
    document.body.append(el);
    lightbox = { el, destroy: built.destroy, nav };
  }

  class GrimImages extends HTMLElement {
    connectedCallback() {
      if (this._init) return;
      this._init = true;
      this.ready = domReady().then(() => this._load()).catch(err => this.append(h('div', { class: 'gr-error', text: String(err.message || err) })));
    }
    async _load() {
      const specs = [];
      const src = this.getAttribute('src');
      if (src) {
        const base = absUrl(src);
        const j = JSON.parse(await fetchText(src));
        for (const it of (Array.isArray(j) ? j : j.images || [])) {
          const fix = k => it[k] && (it[k] = absUrl(it[k], base));
          fix('src'); fix('before'); fix('after');
          specs.push(it);
        }
      }
      for (const c of [...this.children]) {
        if (c.tagName === 'IMG') specs.push({ src: c.getAttribute('src'), caption: c.getAttribute('alt') || c.title });
        else if (c.tagName === 'FIGURE') { const im = c.querySelector('img'); if (im) specs.push({ src: im.getAttribute('src'), caption: c.querySelector('figcaption')?.textContent.trim() || im.alt }); }
        else if (c.tagName === 'GRIM-COMPARE') specs.push(compareSpec(c));
      }
      this.textContent = '';
      const cols = this.getAttribute('columns');
      const grid = h('div', { class: 'gi-grid', style: cols ? `--gi-cols:${cols}` : null });
      if (this.getAttribute('layout') === 'row') grid.classList.add('gi-row');
      const singles = specs.filter(s => !s.before);
      for (const s of specs) {
        if (s.before) {
          s._open = () => openLightbox([s], 0);
          grid.append(h('div', { class: 'gi-wide' }, buildCompare(s).el));
        } else {
          grid.append(buildImageTile(s, () => openLightbox(singles, singles.indexOf(s))).el);
        }
      }
      this.append(grid);
    }
  }
  const compareSpec = c => ({ before: c.getAttribute('before'), after: c.getAttribute('after'), caption: c.getAttribute('caption') || '', mode: c.getAttribute('mode') || 'side', beforeLabel: c.getAttribute('before-label'), afterLabel: c.getAttribute('after-label') });
  class GrimCompare extends HTMLElement {
    connectedCallback() {
      if (this._init || this.closest('grim-images')) return;
      this._init = true;
      domReady().then(() => {
        const s = compareSpec(this);
        s._open = () => openLightbox([s], 0);
        this.append(buildCompare(s).el);
      });
    }
  }

  // ---------- prose primitives ----------
  class GrimSection extends HTMLElement {
    connectedCallback() {
      if (this._init) return;
      this._init = true;
      const t = this.getAttribute('heading');
      if (t) this.prepend(h('h2', { class: 'gr-section-head', text: t }), this.getAttribute('subtitle') ? h('p', { class: 'gr-section-sub', text: this.getAttribute('subtitle') }) : '');
    }
  }
  const NOTE_LABEL = { info: 'Note', question: 'Question for the reviewer', warning: 'Heads up', done: 'Done', decision: 'Decision needed' };
  let qCount = 0;
  class GrimNote extends HTMLElement {
    connectedCallback() {
      if (this._init) return;
      this._init = true;
      const kind = this.getAttribute('kind') || 'info';
      this.classList.add('gn-' + kind);
      const body = h('div', { class: 'gn-body' });
      body.append(...this.childNodes);
      this.append(h('div', { class: 'gn-label', text: this.getAttribute('label') || NOTE_LABEL[kind] || kind }), body);
      if (kind === 'question' || kind === 'decision') {
        const id = this.id || 'q' + (++qCount);
        this.qid = id;
        const ta = h('textarea', { class: 'gn-answer', rows: 2, placeholder: 'Your answer (sent with the review)' });
        ta.value = state.answers[id]?.answer || '';
        ta.addEventListener('input', () => { state.answers[id] = { q: body.textContent.trim(), answer: ta.value }; save(); emit(); });
        document.addEventListener('grim-review-restored', () => { ta.value = state.answers[id]?.answer || ''; });
        this.append(ta);
      }
    }
  }
  let clCount = 0;
  class GrimChecklist extends HTMLElement {
    connectedCallback() {
      if (this._init) return;
      this._init = true;
      domReady().then(() => {
        const id = this.id || 'checklist' + (++clCount);
        const items = [...this.querySelectorAll('li')].map(li => li.textContent.trim());
        const title = this.getAttribute('heading') || '';
        this.textContent = '';
        const cur = state.checks[id] || { title, items: items.map(t => ({ text: t, checked: false })) };
        cur.title = title;
        cur.items = items.map(t => ({ text: t, checked: !!cur.items.find(x => x.text === t)?.checked }));
        state.checks[id] = cur;
        if (title) this.append(h('div', { class: 'gk-title', text: title }));
        const boxes = cur.items.map(it => {
          const cb = h('input', { type: 'checkbox' }); cb.checked = it.checked;
          cb.addEventListener('change', () => { it.checked = cb.checked; state.checks[id] = cur; save(); emit(); });
          this.append(h('label', { class: 'gk-item' }, cb, h('span', { text: it.text })));
          return cb;
        });
        document.addEventListener('grim-review-restored', () => {
          const got = state.checks[id];
          if (got) cur.items.forEach((it, i) => { it.checked = !!got.items.find(x => x.text === it.text)?.checked; boxes[i].checked = it.checked; });
          state.checks[id] = cur;
        });
      });
    }
  }
  class GrimVideo extends HTMLElement {
    connectedCallback() {
      if (this._init) return;
      this._init = true;
      const v = h('video', { src: this.getAttribute('src'), poster: this.getAttribute('poster'), controls: true, preload: 'metadata', playsinline: true });
      this.append(h('figure', { class: 'gv' }, v, this.getAttribute('caption') && h('figcaption', { text: this.getAttribute('caption') })));
    }
  }

  // ---------- review payload ----------
  async function rasterRows(view, i0, i1, anns, title) {
    const host = view.host, rows = view.surf.el.rows;
    const top = rows[i0].offsetTop, bottom = rows[i1].offsetTop + rows[i1].offsetHeight;
    const W = host.clientWidth, H = bottom - top, HEAD = 30, S = 2;
    const cv = h('canvas'); cv.width = W * S; cv.height = (H + HEAD) * S;
    const g = cv.getContext('2d');
    g.scale(S, S);
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H + HEAD);
    g.fillStyle = '#f4f4f5'; g.fillRect(0, 0, W, HEAD);
    g.fillStyle = '#1d1e22'; g.font = `600 12px ${getComputedStyle(document.body).fontFamily}`; g.textBaseline = 'middle';
    g.fillText(title, 10, HEAD / 2, W - 20);
    g.translate(0, HEAD - top);
    const hr = host.getBoundingClientRect();
    const rng = document.createRange();
    for (let i = i0; i <= i1; i++) {
      const row = rows[i];
      for (const cell of [row, ...row.children]) {
        const bg = getComputedStyle(cell).backgroundColor;
        if (bg && bg !== 'transparent' && !/rgba\(.*, 0\)$/.test(bg)) {
          const r = cell.getBoundingClientRect(); g.fillStyle = bg; g.fillRect(r.left - hr.left, r.top - hr.top, r.width, r.height);
        }
        if (cell !== row) cell.querySelectorAll('.gd-x').forEach(x => {
          const cs = getComputedStyle(x).backgroundColor;
          for (const r of x.getClientRects()) { g.fillStyle = cs; g.fillRect(r.left - hr.left, r.top - hr.top, r.width, r.height); }
        });
      }
      const tw = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let n; (n = tw.nextNode());) {
        if (!n.data.trim()) continue;
        const cs = getComputedStyle(n.parentElement);
        g.fillStyle = cs.color; g.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; g.textBaseline = 'middle';
        rng.selectNodeContents(n);
        const rects = rng.getClientRects();
        if (rects.length <= 1) { const r = rects[0] || rng.getBoundingClientRect(); g.fillText(n.data, r.left - hr.left, r.top - hr.top + r.height / 2); continue; }
        for (let c = 0; c < n.data.length; c++) {
          rng.setStart(n, c); rng.setEnd(n, c + 1);
          const r = rng.getBoundingClientRect();
          if (r.width) g.fillText(n.data[c], r.left - hr.left, r.top - hr.top + r.height / 2);
        }
      }
    }
    drawAnns(g, view, anns, 1);
    return { dataUrl: cv.toDataURL('image/png'), width: cv.width, height: cv.height };
  }
  function drawAnns(g, view, anns, scale) {
    for (const a of anns) {
      if (a.type === 'stroke') {
        const pts = a.pts.map(p => view.toPx(a, p));
        if (pts.some(p => !p)) continue;
        g.save();
        g.lineCap = 'round'; g.lineJoin = 'round';
        g.strokeStyle = a.color; g.lineWidth = view.widthPx(a) * scale;
        if (a.tool === 'hl') { g.globalAlpha = 0.35; g.globalCompositeOperation = 'multiply'; }
        g.stroke(new Path2D(pathD(pts.map(p => [p[0] * scale, p[1] * scale]))));
        g.restore();
      }
    }
    for (const a of anns) {
      if (a.type !== 'comment') continue;
      const p = view.toPx(a, [a.x, a.y]);
      if (!p) continue;
      const R = 10 * Math.max(1, scale * 0.8);
      g.save();
      g.fillStyle = a.color; g.strokeStyle = '#fff'; g.lineWidth = 2 * Math.max(1, scale * 0.8);
      g.beginPath(); g.arc(p[0] * scale, p[1] * scale, R, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = '#fff'; g.font = `700 ${Math.round(R * 1.1)}px -apple-system, system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(a.n), p[0] * scale, p[1] * scale + 0.5);
      g.restore();
    }
  }
  async function rasterImage(view, anns, title) {
    const img = view.surf.img && view.surf.img.complete ? view.surf.img : view.host.querySelector('img');
    if (img && img.decode) await img.decode().catch(() => {});
    const nw = img?.naturalWidth || view.size()[0] || 800, nh = img?.naturalHeight || view.size()[1] || 600;
    const sc = Math.min(1, 1600 / nw), W = Math.round(nw * sc), H = Math.round(nh * sc), HEAD = Math.round(30 * Math.max(1, W / 900));
    const cv = h('canvas'); cv.width = W; cv.height = H + HEAD;
    const g = cv.getContext('2d');
    const paint = withImage => {
      g.fillStyle = '#fff'; g.fillRect(0, 0, W, H + HEAD);
      g.fillStyle = '#f4f4f5'; g.fillRect(0, 0, W, HEAD);
      g.fillStyle = '#1d1e22'; g.font = `600 ${Math.round(HEAD * 0.42)}px -apple-system, system-ui, sans-serif`; g.textBaseline = 'middle';
      g.fillText(title, HEAD * 0.35, HEAD / 2, W - HEAD);
      g.save(); g.translate(0, HEAD);
      if (withImage && img) g.drawImage(img, 0, 0, W, H);
      else { g.fillStyle = '#8b8b93'; g.fillText('(image could not be embedded)', 12, 20); }
      // map normalized coords to this canvas: a fake view of size W×H
      const fake = { toPx: (a, p) => [p[0] * W, p[1] * H], widthPx: a => a.w * W };
      drawAnns(g, fake, anns, 1);
      g.restore();
    };
    paint(true);
    let dataUrl;
    try { dataUrl = cv.toDataURL('image/png'); } catch { paint(false); dataUrl = cv.toDataURL('image/png'); }
    return { dataUrl, width: W, height: H + HEAD };
  }
  const primaryView = s => [...s.views].find(v => v.host.isConnected && !v.host.closest('.gr-lightbox')) || [...s.views].find(v => v.host.isConnected);

  function lineInfo(key, d) {
    if (!key) return null;
    const t = key[0], num = +key.slice(1);
    if (t === 'h') { const hk = d.file.hunks[num]; return { side: 'hunk', line: hk ? hk.n : null, code: hk ? `@@ -${hk.o},${hk.ro} +${hk.n},${hk.rn} @@` : '' }; }
    for (const hk of d.file.hunks) for (const l of hk.lines) if ((t === 'n' ? l.n : l.o) === num && (t === 'n' ? l.t !== '-' : true)) return { side: t === 'n' ? 'new' : 'old', line: num, code: l.s, change: l.t === '+' ? 'added' : l.t === '-' ? 'removed' : 'context' };
    return { side: t === 'n' ? 'new' : 'old', line: num };
  }

  async function buildPayload(filterIds) {
    const anns = state.anns.filter(a => !filterIds || filterIds.includes(a.s));
    const bySurf = new Map();
    for (const a of anns) { if (!bySurf.has(a.s)) bySurf.set(a.s, []); bySurf.get(a.s).push(a); }
    const ids = docOrder([...bySurf.keys()]);
    const items = [];
    let imgN = 0;
    for (const sid of ids) {
      const sa = bySurf.get(sid), s = surfaces.get(sid);
      const comments = a => a.filter(x => x.type === 'comment').sort((x, y) => x.n - y.n);
      if (!s) { items.push({ kind: 'unknown', surface: sid, label: sid, comments: comments(sa).map(c => ({ n: c.n, text: c.text })), strokes: sa.length - comments(sa).length, annotationIds: sa.map(a => a.id) }); continue; }
      if (s.kind === 'diff') {
        const d = s.el;
        if (d.collapsed) { d.collapsed = false; await frame(); }
        const v = primaryView(s);
        const rows = d.rows, idx = r => rows.indexOf(r);
        const ranges = sa.map(a => {
          const top = v.rowTop(a.a); if (top == null) return null;
          const ys = a.type === 'stroke' ? a.pts.map(p => top + p[1]) : [top + a.y];
          const r0 = idx(d.rowMap.get(d.rowAt(Math.min(...ys)))), r1 = idx(d.rowMap.get(d.rowAt(Math.max(...ys))));
          return { a, r0: Math.max(0, r0), r1: Math.max(0, r1) };
        }).filter(Boolean).sort((x, y) => x.r0 - y.r0);
        const clusters = [];
        for (const r of ranges) {
          const c = clusters[clusters.length - 1];
          if (c && r.r0 <= c.r1 + 10) { c.r1 = Math.max(c.r1, r.r1); c.anns.push(r.a); } else clusters.push({ r0: r.r0, r1: r.r1, anns: [r.a] });
        }
        for (const c of clusters) {
          const i0 = Math.max(0, c.r0 - 2), i1 = Math.min(rows.length - 1, c.r1 + 2, i0 + 120);
          const nums = { o: [], n: [] };
          for (let i = c.r0; i <= c.r1; i++) { if (rows[i].dataset.o) nums.o.push(+rows[i].dataset.o); if (rows[i].dataset.n) nums.n.push(+rows[i].dataset.n); }
          const span = a => a.length ? [Math.min(...a), Math.max(...a)] : null;
          const lines = { new: span(nums.n), old: span(nums.o) };
          const excerpt = [];
          for (const hk of d.file.hunks) for (const l of hk.lines) {
            if ((lines.new && l.n != null && l.n >= lines.new[0] && l.n <= lines.new[1]) || (lines.old && l.o != null && l.t === '-' && l.o >= lines.old[0] && l.o <= lines.old[1])) excerpt.push(l.t + l.s);
          }
          const desc = lines.new ? `lines ${lines.new[0]}${lines.new[1] !== lines.new[0] ? '–' + lines.new[1] : ''}` : lines.old ? `old lines ${lines.old[0]}${lines.old[1] !== lines.old[0] ? '–' + lines.old[1] : ''}` : '';
          const name = `annot-${++imgN}.png`;
          const png = await rasterRows(v, i0, i1, c.anns, `${s.file}${desc ? ' · ' + desc : ''}`);
          items.push({
            kind: 'diff', surface: sid, label: s.file, file: s.file, lines, linesLabel: desc,
            comments: comments(c.anns).map(x => ({ n: x.n, text: x.text, ...lineInfo(x.a, d) })),
            strokes: c.anns.filter(x => x.type === 'stroke').length,
            excerpt: excerpt.slice(0, 80).join('\n'),
            image: { name, ...png }, annotationIds: c.anns.map(a => a.id),
          });
        }
      } else {
        const v = primaryView(s);
        const name = `annot-${++imgN}.png`;
        const png = v ? await rasterImage(v, sa, s.label) : null;
        items.push({
          kind: 'image', surface: sid, label: s.label, src: s.src && absUrl(s.src),
          comments: comments(sa).map(x => ({ n: x.n, text: x.text, x: x.x, y: x.y, where: `${Math.round(x.x * 100)}% across, ${Math.round(x.y * 100)}% down` })),
          strokes: sa.filter(x => x.type === 'stroke').length,
          image: png && { name, ...png }, annotationIds: sa.map(a => a.id),
        });
      }
    }
    const answers = filterIds ? [] : Object.entries(state.answers).filter(([, v]) => v.answer && v.answer.trim()).map(([id, v]) => ({ id, question: v.q, answer: v.answer.trim() }));
    const checklists = filterIds ? [] : Object.entries(state.checks).map(([id, c]) => ({ id, title: c.title, items: c.items })).filter(c => c.items.length);
    const p = {
      type: 'grim-review', version: VERSION, createdAt: new Date().toISOString(),
      artifact: { url: location.href.split('#')[0], path: decodeURIComponent(location.pathname), title: document.title || baseName(location.pathname) },
      overall: filterIds ? '' : state.overall.trim(), items, answers, checklists,
    };
    p.markdown = toMarkdown(p);
    return p;
  }
  function toMarkdown(p, imageRef = n => n) {
    const L = [`# Review: ${p.artifact.title}`, '', `Artifact: ${p.artifact.path}`, ''];
    if (p.overall) L.push(p.overall, '');
    p.items.forEach((it, i) => {
      L.push(`## ${i + 1}. ${it.kind === 'diff' ? '`' + it.file + '`' + (it.linesLabel ? ', ' + it.linesLabel : '') : it.kind === 'image' ? 'Image: ' + it.label : it.label}`, '');
      if (it.image) L.push(`![annotated ${it.kind}](${imageRef(it.image.name)})`, '');
      for (const c of it.comments) {
        const where = it.kind === 'diff' && c.line != null ? `**${c.side === 'old' ? 'old line' : 'line'} ${c.line}**${c.code ? ' (`' + c.code.trim().slice(0, 80).replace(/`/g, "'") + '`)' : ''}: ` : it.kind === 'image' ? `*(${c.where})* ` : '';
        L.push(`${c.n}. ${where}${c.text}`);
      }
      if (it.comments.length) L.push('');
      if (it.strokes) L.push(`_${it.strokes} drawing${it.strokes === 1 ? '' : 's'} on the image above._`, '');
      if (it.excerpt) L.push('```diff', it.excerpt, '```', '');
    });
    if (p.answers.length) { L.push('## Answers'); for (const a of p.answers) L.push('', `**Q:** ${a.question}`, `**A:** ${a.answer}`); L.push(''); }
    for (const c of p.checklists) { L.push(`## ${c.title || 'Checklist'}`); for (const it of c.items) L.push(`- [${it.checked ? 'x' : ' '}] ${it.text}`); L.push(''); }
    return L.join('\n').trim() + '\n';
  }

  let sendTimer = null, pendingSend = null;
  async function send(filterIds) {
    if (ui.sending) return;
    const p = await buildPayload(filterIds);
    api.lastPayload = p;
    if (!p.items.length && !p.overall && !p.answers.length && !p.checklists.some(c => c.items.some(i => i.checked))) { toast('Nothing to send yet: draw or comment first'); return p; }
    const b = bridge();
    if (b) {
      ui.sending = true; pendingSend = p; emit();
      post(p);
    } else showFallback(p);
    document.dispatchEvent(new CustomEvent('grim-review-payload', { detail: p }));
    return p;
  }
  function post(p, session) {
    try { bridge().postMessage(JSON.stringify({ type: 'review', payload: p, session })); } catch (e) { hostResult({ ok: false, error: String(e) }); return; }
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => { if (ui.sending) hostResult({ ok: false, error: 'No answer from Grim' }); }, 120000);
  }
  // Called by the host when it can't tell which session made this page: the reviewer picks one, and it's sent again.
  function hostPick(list) {
    clearTimeout(sendTimer);
    const p = pendingSend;
    if (!p) return;
    const close = () => { m.remove(); if (ui.sending && pendingSend === p) { ui.sending = false; pendingSend = null; emit(); } };
    const m = h('div', { class: 'gr-modal-back', onclick: e => { if (e.target === m) close(); } },
      h('div', { class: 'gr-modal gr-pick' },
        h('div', { class: 'gr-modal-head' }, h('b', { text: 'Send the review to which session?' }), h('span', { class: 'gr-grow' }), h('button', { class: 'gr-btn gr-btn-icon', html: I.close, onclick: close })),
        h('p', { class: 'gr-dim', text: 'Grim couldn’t tell which agent session made this page. Recent sessions on your OpenCode server:' }),
        list.length ? list.map(s => h('button', { class: 'gr-pick-item', onclick: () => { m.remove(); post(p, s.id); } }, h('b', { text: s.title || s.id }), h('span', { class: 'gr-dim', text: s.directory || s.id }))) : h('p', { text: 'No sessions found.' })));
    document.body.append(m);
  }
  // Called by the host (Grim for Mac) once it has sent (or failed to send) the review.
  function hostResult(r) {
    clearTimeout(sendTimer);
    ui.sending = false;
    const p = pendingSend; pendingSend = null;
    if (r && r.ok) {
      const done = new Set((p ? p.items.flatMap(i => i.annotationIds || []) : []));
      mutate(() => {
        state.anns = state.anns.filter(a => !done.has(a.id));
        if (p && p.overall) state.overall = '';
      });
      toast(r.message || `Review sent to ${r.session || 'the session'}`);
    } else { emit(); toast((r && r.error) || 'Couldn’t send the review', true); }
  }
  function showFallback(p) {
    const ta = h('textarea', { class: 'gf-md', readonly: true }); ta.value = p.markdown;
    const copy = async () => {
      try { await navigator.clipboard.writeText(p.markdown); } catch { ta.select(); document.execCommand('copy'); }
      toast('Review copied as Markdown');
    };
    const m = h('div', { class: 'gr-modal-back', onclick: e => { if (e.target === m) m.remove(); } },
      h('div', { class: 'gr-modal' },
        h('div', { class: 'gr-modal-head' }, h('b', { text: 'Copy review as Markdown' }), h('span', { class: 'gr-grow' }), h('button', { class: 'gr-btn gr-btn-icon', html: I.close, onclick: () => m.remove() })),
        h('p', { class: 'gr-dim', text: 'Not running inside Grim, so this review can’t go straight to the agent. Copy it, and save the annotated images next to it.' }),
        ta,
        p.items.some(i => i.image) && h('div', { class: 'gf-imgs' }, p.items.filter(i => i.image).map(i => h('a', { href: i.image.dataUrl, download: i.image.name, title: 'Download ' + i.image.name }, h('img', { src: i.image.dataUrl }), h('span', { text: i.image.name })))),
        h('div', { class: 'gr-editor-row' },
          h('button', { class: 'gr-btn gr-btn-quiet', text: 'Clear annotations', onclick: () => { mutate(() => { state.anns = []; }); m.remove(); } }),
          h('span', { class: 'gr-grow' }),
          h('button', { class: 'gr-btn gr-btn-primary', text: 'Copy Markdown', onclick: copy }))));
    document.body.append(m);
  }

  // ---------- toolbar, tray, toast ----------
  let toastEl = null, toastTimer = null;
  function toast(msg, err) {
    if (!toastEl) { toastEl = h('div', { class: 'gr-toast', role: 'status' }); document.body.append(toastEl); }
    toastEl.textContent = msg; toastEl.classList.toggle('gr-toast-err', !!err); toastEl.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
  }
  let bar, tray;
  function setAnnotating(on) {
    ui.annotating = on;
    document.documentElement.classList.toggle('gr-annotating', on);
    if (!on) closeEditor();
    renderBar();
  }
  function setTool(t) { ui.tool = t; if (t === 'hl' && ui.color === '#e5484d') ui.color = '#f5a524'; document.documentElement.dataset.grTool = t; renderBar(); }
  const sendLabel = () => bridge() ? 'Send to session' : 'Copy as Markdown';
  function renderBar() {
    if (!bar) return;
    bar.textContent = '';
    const n = state.anns.length;
    const tb = (name, title, on, fn, extra) => h('button', { class: 'gr-tb' + (on ? ' on' : '') + (extra || ''), title, 'aria-label': title, 'aria-pressed': on ? 'true' : null, onclick: fn }, icon(name));
    if (!ui.annotating) {
      bar.append(h('button', { class: 'gr-tb gr-tb-text', onclick: () => setAnnotating(true) }, icon('pen'), 'Annotate'));
    } else {
      bar.append(
        h('button', { class: 'gr-tb gr-tb-text gr-tb-done', onclick: () => setAnnotating(false), title: 'Stop annotating (Esc)' }, 'Done'),
        h('span', { class: 'gr-sep' }),
        tb('pen', 'Pen', ui.tool === 'pen', () => setTool('pen')),
        tb('hl', 'Highlighter', ui.tool === 'hl', () => setTool('hl')),
        tb('comment', 'Comment: click to pin a note', ui.tool === 'comment', () => setTool('comment')),
        h('span', { class: 'gr-sep' }),
        ...COLORS.map(c => h('button', { class: 'gr-swatch' + (ui.color === c ? ' on' : ''), style: `--c:${c}`, title: 'Colour', 'aria-label': 'Colour ' + c, onclick: () => { ui.color = c; renderBar(); } })),
        h('span', { class: 'gr-sep' }),
        tb('undo', 'Undo (⌘Z)', false, undo, undoStack.length ? '' : ' dis'),
        tb('trash', 'Clear all annotations', false, () => { if (state.anns.length && confirm('Clear all annotations on this page?')) mutate(() => state.anns = []); }));
    }
    bar.append(h('span', { class: 'gr-sep' }),
      h('button', { class: 'gr-tb gr-tb-text' + (ui.trayOpen ? ' on' : ''), title: 'Review tray', onclick: () => { ui.trayOpen = !ui.trayOpen; renderTray(); renderBar(); } }, icon('list'), 'Review', n ? h('span', { class: 'gr-count', text: n }) : null),
      h('button', { class: 'gr-tb gr-tb-text gr-tb-send', disabled: ui.sending || null, title: sendLabel(), onclick: () => send() }, icon('send'), ui.sending ? 'Sending…' : (bridge() ? 'Send' : 'Copy')));
  }
  function renderTray() {
    if (!tray) return;
    tray.classList.toggle('open', ui.trayOpen);
    if (!ui.trayOpen) return;
    const active = document.activeElement && tray.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA';
    if (active) return;
    tray.textContent = '';
    const overall = h('textarea', { class: 'gt-overall', rows: 3, placeholder: 'Overall comment (optional)' });
    overall.value = state.overall;
    overall.addEventListener('input', () => { state.overall = overall.value; save(); });
    const groups = new Map();
    for (const a of state.anns) { if (!groups.has(a.s)) groups.set(a.s, []); groups.get(a.s).push(a); }
    const list = h('div', { class: 'gt-list' });
    docOrder([...groups.keys()]).forEach(sid => {
      const anns = groups.get(sid), s = surfaces.get(sid);
      const strokes = anns.filter(a => a.type === 'stroke').length;
      const lines = s && s.kind === 'diff' ? [...new Set(anns.map(a => a.a))].map(k => k[0] === 'h' ? 'hunk' : (k[0] === 'o' ? 'old ' : 'L') + k.slice(1)).slice(0, 6).join(', ') : '';
      list.append(h('div', { class: 'gt-group' },
        h('div', { class: 'gt-gh' },
          h('button', { class: 'gt-label', title: 'Show', text: s ? s.label : sid + ' (not on this page)', onclick: () => { const v = s && primaryView(s); if (v) { if (s.kind === 'diff') s.el.collapsed = false; v.host.scrollIntoView({ block: 'center', behavior: 'smooth' }); } } }),
          h('span', { class: 'gr-grow' }),
          h('button', { class: 'gr-btn gr-btn-small', text: bridge() ? 'Send' : 'Copy', title: 'Send just this', onclick: () => send([sid]) }),
          h('button', { class: 'gr-btn gr-btn-small gr-btn-icon', title: 'Remove these annotations', html: I.trash, onclick: () => mutate(() => state.anns = state.anns.filter(a => a.s !== sid)) })),
        h('div', { class: 'gt-meta', text: [s ? (s.kind === 'diff' ? 'Diff' : 'Image') : '', lines, strokes ? `${strokes} drawing${strokes === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') }),
        anns.filter(a => a.type === 'comment').sort((a, b) => a.n - b.n).map(c => {
          const t = h('textarea', { rows: 1, class: 'gt-c' }); t.value = c.text;
          t.addEventListener('change', () => mutate(() => { c.text = t.value; }));
          return h('div', { class: 'gt-comment' }, h('span', { class: 'gt-n', style: `background:${c.color}`, text: c.n }), t,
            h('button', { class: 'gr-btn gr-btn-small gr-btn-icon', title: 'Delete comment', html: I.close, onclick: () => mutate(() => state.anns = state.anns.filter(a => a !== c)) }));
        })));
    });
    const answers = Object.values(state.answers).filter(a => a.answer && a.answer.trim()).length;
    const checks = Object.values(state.checks).reduce((n, c) => n + c.items.filter(i => i.checked).length, 0);
    tray.append(
      h('div', { class: 'gt-head' }, h('b', { text: 'Review' }), h('span', { class: 'gr-grow' }), h('button', { class: 'gr-btn gr-btn-icon', html: I.close, title: 'Close', onclick: () => { ui.trayOpen = false; renderTray(); renderBar(); } })),
      overall,
      groups.size ? list : h('p', { class: 'gr-dim gt-empty', text: 'No annotations yet. Press Annotate, then draw on any diff or image, or pin a comment.' }),
      (answers || checks) ? h('p', { class: 'gr-dim', text: [answers && `${answers} answer${answers === 1 ? '' : 's'}`, checks && `${checks} checklist item${checks === 1 ? '' : 's'} ticked`].filter(Boolean).join(' · ') + ' will be included.' }) : null,
      h('div', { class: 'gt-foot' }, h('button', { class: 'gr-btn gr-btn-primary gt-send', disabled: ui.sending || null, onclick: () => send() }, icon('send'), ui.sending ? 'Sending…' : sendLabel())));
  }
  listeners.add(() => { renderBar(); renderTray(); });

  document.addEventListener('keydown', e => {
    const typing = /^(TEXTAREA|INPUT)$/.test(document.activeElement?.tagName);
    if (e.key === 'Escape') {
      if (editorEl) closeEditor(); else if (lightbox) closeLightbox(); else if (ui.trayOpen) { ui.trayOpen = false; renderTray(); renderBar(); } else if (ui.annotating) setAnnotating(false);
    } else if (!typing && e.key.toLowerCase() === 'z' && (e.metaKey || e.ctrlKey) && !e.shiftKey && state.anns.length) { e.preventDefault(); undo(); }
    else if (lightbox && !typing && e.key === 'ArrowLeft') lightbox.nav(-1);
    else if (lightbox && !typing && e.key === 'ArrowRight') lightbox.nav(1);
  });

  if (bridge()) try { bridge().postMessage(JSON.stringify({ type: 'load' })); } catch {}
  domReady().then(() => {
    document.documentElement.classList.add('gr-page');
    document.documentElement.dataset.grTool = ui.tool;
    bar = h('div', { class: 'gr-toolbar', role: 'toolbar', 'aria-label': 'Review' });
    tray = h('aside', { class: 'gr-tray', 'aria-label': 'Review tray' });
    document.body.append(tray, bar);
    renderBar();
  });

  for (const [n, c] of [['grim-diff', GrimDiff], ['grim-diff-stack', GrimDiffStack], ['grim-images', GrimImages], ['grim-compare', GrimCompare], ['grim-section', GrimSection], ['grim-note', GrimNote], ['grim-checklist', GrimChecklist], ['grim-video', GrimVideo]]) {
    if (!customElements.get(n)) customElements.define(n, c);
  }

  const api = window.grimReview = {
    version: VERSION, state: () => state, surfaces, ui,
    setAnnotating, setTool, setColor: c => { ui.color = c; renderBar(); }, undo,
    clear: () => mutate(() => state.anns = []),
    buildPayload, send, hostResult, hostPick, restore, toMarkdown, toast,
    parsePatch, diffLines, lastPayload: null,
  };
})();
