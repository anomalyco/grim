import type * as Y from "yjs";

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

/** Apply sorted, non-overlapping splices (positions in the current text) to `ytext`; returns the index after the last change. */
export function applyToYText(ytext: Y.Text, splices: Splice[]): number {
  let shift = 0;
  for (const s of splices) shift += s.ins.length - s.del;
  for (let i = splices.length - 1; i >= 0; i--) {
    const s = splices[i]!;
    if (s.del) ytext.delete(s.pos, s.del);
    if (s.ins) ytext.insert(s.pos, s.ins);
  }
  const last = splices[splices.length - 1];
  return last ? last.pos + last.ins.length + shift - (last.ins.length - last.del) : 0;
}

/** Turn the text of `ytext` (currently `from`) into `to` with a minimal edit. Returns the splices applied. */
export function applyDiff(ytext: Y.Text, from: string, to: string): Splice[] {
  const splices = diffText(from, to);
  applyToYText(ytext, splices);
  return splices;
}
