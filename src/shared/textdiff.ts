// Text diffs and merges on plain strings (UTF-16 offsets), shared by the server (agent patches, Git merges) and
// the client (crash recovery, recover.ts).

/** A replacement of `del` characters at `pos` (in the OLD string) by `ins`. */
export interface Splice {
  pos: number;
  del: number;
  ins: string;
}

function lines(s: string): string[] {
  const out = s.split(/(?<=\n)/);
  return out.length === 1 && out[0] === "" ? [] : out;
}

/** Myers diff over arrays; returns matched index pairs (a, b) in order. */
function lcsPairs<T>(a: T[], b: T[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[k - 1 + max]! < v[k + 1 + max]!) ? v[k + 1 + max]! : v[k - 1 + max]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + max] = x;
      if (x >= n && y >= m) {
        const pairs: Array<[number, number]> = [];
        let cx = n;
        let cy = m;
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd]!;
          const kk = cx - cy;
          const prevK = kk === -dd || (kk !== dd && pv[kk - 1 + max]! < pv[kk + 1 + max]!) ? kk + 1 : kk - 1;
          const px = pv[prevK + max]!;
          const py = px - prevK;
          while (cx > px && cy > py) pairs.push([--cx, --cy]);
          cx = px;
          cy = py;
        }
        while (cx > 0 && cy > 0) pairs.push([--cx, --cy]);
        return pairs.reverse();
      }
    }
  }
  return [];
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

function charSplices(a: string, b: string, offset: number): Splice[] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  // Never cut a surrogate pair in half.
  if (p > 0 && isHigh(a.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  if (s > 0 && isLow(a.charCodeAt(a.length - s))) s--;
  if (p === a.length && p === b.length) return [];
  return [{ pos: offset + p, del: a.length - p - s, ins: b.slice(p, b.length - s) }];
}

/** Minimal-ish edit script from `a` to `b`: line-level Myers diff, refined to characters inside changed hunks. */
export function diffText(a: string, b: string): Splice[] {
  if (a === b) return [];
  const la = lines(a);
  const lb = lines(b);
  // Common leading and trailing lines are matched directly; Myers only runs on the middle.
  let pre = 0;
  while (pre < la.length && pre < lb.length && la[pre] === lb[pre]) pre++;
  let suf = 0;
  while (suf < la.length - pre && suf < lb.length - pre && la[la.length - 1 - suf] === lb[lb.length - 1 - suf]) suf++;
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < pre; i++) pairs.push([i, i]);
  for (const [x, y] of lcsPairs(la.slice(pre, la.length - suf), lb.slice(pre, lb.length - suf))) pairs.push([x + pre, y + pre]);
  for (let i = suf; i > 0; i--) pairs.push([la.length - i, lb.length - i]);
  const out: Splice[] = [];
  let ia = 0;
  let ib = 0;
  let pos = 0;
  const flush = (ea: number, eb: number) => {
    if (ea > ia || eb > ib) {
      const oldChunk = la.slice(ia, ea).join("");
      const newChunk = lb.slice(ib, eb).join("");
      out.push(...charSplices(oldChunk, newChunk, pos));
      pos += oldChunk.length;
    }
  };
  for (const [x, y] of pairs) {
    flush(x, y);
    pos += la[x]!.length;
    ia = x + 1;
    ib = y + 1;
  }
  flush(la.length, lb.length);
  return out;
}

/** Apply splices (positions in the original string). */
export function applySplices(s: string, splices: Splice[]): string {
  let out = s;
  for (let i = splices.length - 1; i >= 0; i--) {
    const sp = splices[i]!;
    out = out.slice(0, sp.pos) + sp.ins + out.slice(sp.pos + sp.del);
  }
  return out;
}

/**
 * Whether a change of `theirs` and one of `ours` (both on the same base) touch: deletions that overlap, or an
 * insertion at or inside the other's range.
 */
function touches(t: Splice, s: Splice): boolean {
  const tEnd = t.pos + t.del;
  const end = s.pos + s.del;
  return t.del > 0 && s.del > 0 ? t.pos < end && s.pos < tEnd : t.pos <= end && s.pos <= tEnd;
}

/**
 * `ours` (splices on a base) moved onto the text `theirs` (splices on the same base) produced, or null if one of
 * ours touches one of theirs (the same place was changed on both sides).
 */
export function rebaseSplices(theirs: Splice[], ours: Splice[]): Splice[] | null {
  const out: Splice[] = [];
  for (const s of ours) {
    let shift = 0;
    for (const t of theirs) {
      if (touches(t, s)) return null;
      if (t.pos + t.del <= s.pos) shift += t.ins.length - t.del;
    }
    out.push({ ...s, pos: s.pos + shift });
  }
  return out;
}

/**
 * diffText with each hunk refined to characters (code points) when it's small enough: a hunk spanning lines
 * changed in several places becomes one splice per place, so a merge sees which places really changed.
 */
function fineDiff(a: string, b: string): Splice[] {
  const out: Splice[] = [];
  for (const s of diffText(a, b)) {
    const old = a.slice(s.pos, s.pos + s.del);
    if (!s.del || !s.ins || old.length + s.ins.length > 1000) {
      out.push(s);
      continue;
    }
    const ca = Array.from(old);
    const cb = Array.from(s.ins);
    // UTF-16 offsets of each code point
    const offs = (cs: string[]) => {
      const o = [0];
      for (const c of cs) o.push(o[o.length - 1]! + c.length);
      return o;
    };
    const oa = offs(ca);
    const ob = offs(cb);
    let ia = 0;
    let ib = 0;
    const flush = (ea: number, eb: number) => {
      if (ea > ia || eb > ib) out.push({ pos: s.pos + oa[ia]!, del: oa[ea]! - oa[ia]!, ins: s.ins.slice(ob[ib]!, ob[eb]!) });
    };
    for (const [x, y] of lcsPairs(ca, cb)) {
      flush(x, y);
      ia = x + 1;
      ib = y + 1;
    }
    flush(ca.length, cb.length);
  }
  return out;
}

/** Whether `a` is `b` with some characters left out. */
function isSubsequence(a: string, b: string): boolean {
  let i = 0;
  for (let j = 0; i < a.length && j < b.length; j++) if (a[i] === b[j]) i++;
  return i === a.length;
}

/**
 * 3-way merge: the change base → `ours` replayed on `theirs` (base → theirs). Places changed on one side only take
 * that side's text. A place changed on both sides takes the same text if both agree, else the side that contains
 * the other's text (`theirs` already has part of our edit: an earlier save of it; or someone typed into it): then
 * nothing is inserted twice and nothing either side wrote is dropped; two different insertions at the same place
 * are both kept (theirs first). Otherwise the sides conflict: null.
 * Returns the splices that turn `theirs` into the merged text (positions in `theirs`, in order).
 */
export function merge3(base: string, ours: string, theirs: string): Splice[] | null {
  if (ours === base || ours === theirs) return [];
  const t = fineDiff(base, theirs);
  const o = fineDiff(base, ours);
  // group the splices of both sides into clusters of places that touch, in base order
  type Cluster = { lo: number; hi: number; t: Splice[]; o: Splice[] };
  const clusters: Cluster[] = [];
  const all = [...t.map((s) => ({ s, side: "t" as const })), ...o.map((s) => ({ s, side: "o" as const }))].sort((a, b) => a.s.pos - b.s.pos || a.s.del - b.s.del);
  for (const { s, side } of all) {
    const c = clusters[clusters.length - 1];
    const joins = c && [...c.t, ...c.o].some((x) => touches(x, s));
    const into = joins ? c : { lo: s.pos, hi: s.pos + s.del, t: [], o: [] };
    if (!joins) clusters.push(into);
    into.lo = Math.min(into.lo, s.pos);
    into.hi = Math.max(into.hi, s.pos + s.del);
    into[side].push(s);
  }
  const region = (lo: number, hi: number, ss: Splice[]) => applySplices(base.slice(lo, hi), ss.map((s) => ({ ...s, pos: s.pos - lo })));
  const out: Splice[] = [];
  let shift = 0; // theirs offset - base offset, before the current cluster
  for (const c of clusters) {
    const T = region(c.lo, c.hi, c.t);
    const at = c.lo + shift;
    shift += T.length - (c.hi - c.lo);
    if (!c.o.length) continue;
    const O = region(c.lo, c.hi, c.o);
    let merged: string;
    if (!c.t.length || T === O) merged = O;
    else if (isSubsequence(T, O)) merged = O;
    else if (isSubsequence(O, T)) merged = T;
    else if (c.lo === c.hi) merged = T + O; // both only inserted here: keep both, theirs first
    else return null;
    if (merged !== T) for (const s of diffText(T, merged)) out.push({ ...s, pos: s.pos + at });
  }
  return out;
}
