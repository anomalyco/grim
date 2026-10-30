import { describe, expect, test } from "bun:test";

const { config } = await import("../../src/server/config.ts");
const { clientIp, normalizeIp, notePeer, requestProto } = await import("../../src/server/proxy.ts");
const { sameOrigin } = await import("../../src/server/auth.ts");

describe("behind a proxy", () => {
  const req = (peer: string, headers: Record<string, string> = {}, url = "http://grimoire.exe.xyz/api/me") => {
    const r = new Request(url, { headers });
    notePeer(r, peer);
    return r;
  };

  test("addresses are normalized", () => {
    expect(normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeIp("::FFFF:7f00:1")).toBe("127.0.0.1");
    expect(normalizeIp("[2001:DB8:0:0:0:0:0:1]")).toBe("2001:db8::1");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80::1");
  });

  test("X-Forwarded-For only counts from a trusted proxy (loopback, as on exe.dev)", () => {
    // exe.dev's proxy runs on the VM and connects over loopback; Bun reports it IPv4-mapped
    expect(clientIp(req("::ffff:127.0.0.1", { "x-forwarded-for": "9.9.9.9, 203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(req("::1", { "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(req("::ffff:127.0.0.1"))).toBe("127.0.0.1");
    // anyone else's header is ignored: private ranges, Tailscale, mapped private addresses, public peers
    for (const peer of ["::ffff:10.42.0.7", "10.0.0.2", "192.168.1.5", "fd7a:115c:a1e0::1", "100.101.102.103", "198.51.100.1"]) {
      expect(clientIp(req(peer, { "x-forwarded-for": "1.2.3.4" }))).toBe(normalizeIp(peer));
    }
    // the right-most hop that isn't a trusted proxy, so a client can't pick its own address
    expect(clientIp(req("127.0.0.1", { "x-forwarded-for": "1.1.1.1, 203.0.113.7, 127.0.0.1" }))).toBe("203.0.113.7");
    expect(clientIp(req("127.0.0.1", { "x-forwarded-for": "::ffff:203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(req("127.0.0.1", { "x-forwarded-for": "1.1.1.1, nonsense" }))).toBe("invalid");
    expect(clientIp(new Request("http://x/"))).toBe("unknown");
  });

  test("TRUSTED_PROXIES replaces the default", () => {
    const was = config.trustedProxies;
    try {
      config.trustedProxies = "10.42.0.0/16, fd7a:115c:a1e0::/48";
      expect(clientIp(req("::ffff:10.42.3.4", { "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
      expect(clientIp(req("fd7a:115c:a1e0:ab12::5", { "x-forwarded-for": "203.0.113.8" }))).toBe("203.0.113.8");
      expect(clientIp(req("127.0.0.1", { "x-forwarded-for": "203.0.113.7" }))).toBe("127.0.0.1");
      config.trustedProxies = "none";
      expect(clientIp(req("127.0.0.1", { "x-forwarded-for": "203.0.113.7" }))).toBe("127.0.0.1");
    } finally {
      config.trustedProxies = was;
    }
  });

  test("the forwarded scheme: Secure cookies and same-origin checks behind an https proxy", () => {
    expect(requestProto(req("::ffff:127.0.0.1", { "x-forwarded-proto": "https" }))).toBe("https:");
    expect(requestProto(req("203.0.113.9", { "x-forwarded-proto": "https" }))).toBe("http:");
    const was = process.env.PUBLIC_URL;
    const pub = config.publicUrl;
    delete process.env.PUBLIC_URL;
    config.publicUrl = "http://localhost:8000";
    try {
      const h = { origin: "https://grimoire.exe.xyz", "x-forwarded-proto": "https", "x-forwarded-host": "grimoire.exe.xyz" };
      expect(sameOrigin(req("::ffff:127.0.0.1", h))).toBe(true);
      expect(sameOrigin(req("::ffff:127.0.0.1", { origin: "https://grimoire.exe.xyz", "x-forwarded-proto": "https" }))).toBe(true);
      expect(sameOrigin(req("203.0.113.9", h))).toBe(false);
      expect(sameOrigin(req("::ffff:127.0.0.1", { ...h, origin: "https://evil.example" }))).toBe(false);
      expect(sameOrigin(req("203.0.113.9", { origin: "http://grimoire.exe.xyz" }))).toBe(true);
    } finally {
      config.publicUrl = pub;
      if (was !== undefined) process.env.PUBLIC_URL = was;
    }
  });
});
