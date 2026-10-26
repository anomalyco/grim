// Who is on the other end of a request when we run behind a reverse proxy.
//
// In production (exe.dev) the proxy is exe-init on the VM itself: it connects from loopback (Bun reports
// ::ffff:127.0.0.1), sets X-Forwarded-Proto/Host and appends the client's IP to X-Forwarded-For. So by default only
// loopback peers are trusted proxies. TRUSTED_PROXIES (comma-separated IPs or CIDRs) replaces that list; set it to
// "none" to trust no one. Forwarded headers from any other peer are ignored: they're whatever the client wrote.
import { config } from "./config.ts";

type Addr = { v6: boolean; b: number[] };
type Cidr = Addr & { bits: number };

const peers = new WeakMap<Request, string>();

/** Record the socket peer of a request (index.ts does this for every request). */
export function notePeer(req: Request, addr: string | undefined) {
  if (addr) peers.set(req, addr);
}

/** The socket peer, normalized ("" when unknown). */
export function peerIp(req: Request): string {
  return normalizeIp(peers.get(req) ?? "");
}

/** "::ffff:1.2.3.4" → "1.2.3.4"; brackets and zone ids dropped; IPv6 lower-cased. Invalid input is returned trimmed. */
export function normalizeIp(s: string): string {
  const a = parseIp(s);
  return a ? format(a) : s.trim();
}

let cached: { src: string; list: Cidr[] } | null = null;
function trusted(): Cidr[] {
  const src = config.trustedProxies;
  if (cached?.src !== src) cached = { src, list: parseCidrs(src) };
  return cached.list;
}

export function parseCidrs(src: string): Cidr[] {
  if (src.trim().toLowerCase() === "none") return [];
  const out: Cidr[] = [];
  for (const part of src.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [ip, bits] = part.split("/");
    const a = parseIp(ip!);
    if (!a) {
      console.warn(`TRUSTED_PROXIES: ignoring ${part}`);
      continue;
    }
    const max = a.v6 ? 128 : 32;
    const n = bits === undefined ? max : Number(bits);
    if (!Number.isInteger(n) || n < 0 || n > max) {
      console.warn(`TRUSTED_PROXIES: ignoring ${part}`);
      continue;
    }
    out.push({ ...a, bits: n });
  }
  return out;
}

export function isTrustedProxy(ip: string, list: Cidr[] = trusted()): boolean {
  const a = parseIp(ip);
  if (!a) return false;
  return list.some((c) => c.v6 === a.v6 && inPrefix(a.b, c.b, c.bits, a.v6 ? 16 : 8));
}

/** The request came through a trusted proxy, so its X-Forwarded-* headers are the proxy's. */
export function viaTrustedProxy(req: Request): boolean {
  const p = peers.get(req);
  return !!p && isTrustedProxy(p);
}

/**
 * The client's IP: the socket peer, or, when that's a trusted proxy, the right-most X-Forwarded-For entry that isn't
 * one (each proxy appends the address it saw, so everything left of that could be made up by the client).
 */
export function clientIp(req: Request): string {
  const peer = peers.get(req);
  if (!peer) return "unknown";
  let ip = normalizeIp(peer);
  if (!isTrustedProxy(ip)) return ip;
  const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const a = parseIp(hops[i]!);
    if (!a) return "invalid";
    ip = format(a);
    if (!isTrustedProxy(ip)) return ip;
  }
  return ip;
}

/** The scheme the client used ("https:" or "http:"): X-Forwarded-Proto from a trusted proxy, else the request's own. */
export function requestProto(req: Request): string {
  if (viaTrustedProxy(req)) {
    const p = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    if (p === "https" || p === "http") return `${p}:`;
  }
  return new URL(req.url).protocol;
}

/** The origin the client asked for, as forwarded by a trusted proxy (scheme and X-Forwarded-Host), or null. */
export function forwardedOrigin(req: Request): string | null {
  if (!viaTrustedProxy(req)) return null;
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || new URL(req.url).host;
  if (!host) return null;
  try {
    return new URL(`${requestProto(req)}//${host}`).origin;
  } catch {
    return null;
  }
}

function inPrefix(a: number[], b: number[], bits: number, w: number): boolean {
  for (let i = 0; bits > 0; i++, bits -= w) {
    const m = bits >= w ? (1 << w) - 1 : ((1 << w) - 1) ^ ((1 << (w - bits)) - 1);
    if ((a[i]! & m) !== (b[i]! & m)) return false;
  }
  return true;
}

function parseV4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || +p > 255) return null;
    out.push(+p);
  }
  return out;
}

/** IPv4 as 4 bytes, IPv6 as 8 groups; IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:7f00:1) comes back as IPv4. */
export function parseIp(input: string): Addr | null {
  let s = input.trim();
  if (s.startsWith("[")) s = s.slice(1, s.indexOf("]") > 0 ? s.indexOf("]") : undefined);
  s = s.replace(/%.*$/, "");
  if (!s.includes(":")) {
    const v4 = parseV4(s);
    return v4 ? { v6: false, b: v4 } : null;
  }
  let tail: number[] = [];
  const dot = s.lastIndexOf(":");
  if (s.includes(".", dot)) {
    const v4 = parseV4(s.slice(dot + 1));
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    s = s.slice(0, dot + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const group = (h: string) => (h ? h.split(":") : []);
  const head = group(halves[0]!);
  const rest = halves.length === 2 ? group(halves[1]!) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + rest.length > 7) return null;
  const all = [...head, ...Array(8 - head.length - rest.length).fill("0"), ...rest];
  const b: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    b.push(parseInt(g, 16));
  }
  if (tail.length) {
    b[6] = tail[0]!;
    b[7] = tail[1]!;
  }
  if (b.slice(0, 5).every((x) => x === 0) && b[5] === 0xffff) return { v6: false, b: [b[6]! >> 8, b[6]! & 255, b[7]! >> 8, b[7]! & 255] };
  return { v6: true, b };
}

function format(a: Addr): string {
  if (!a.v6) return a.b.join(".");
  // RFC 5952: longest run of zero groups (2+) becomes ::
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (a.b[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && a.b[j] === 0) j++;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = a.b.map((x) => x.toString(16));
  if (best < 0) return hex.join(":");
  return `${hex.slice(0, best).join(":")}::${hex.slice(best + bestLen).join(":")}`;
}
