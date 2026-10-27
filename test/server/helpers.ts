// Shared bits for the workspace and sign-in tests: a fake Google (keys, tokens, the OAuth dance) and a small room client.
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

export async function waitFor(fn: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting");
}

// ---- fake Google ----

export interface FakeGoogle {
  clientId: string;
  /** Claims to put in the next id_token (merged over the defaults); `sign` picks the key. */
  next: { claims?: Record<string, unknown>; badKey?: boolean; kid?: string; error?: string };
  calls: string[];
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

export async function fakeGoogle(opts: { clientId: string; tokenUrl: string; jwksUrl: string }): Promise<FakeGoogle> {
  const alg = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const good = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
  const bad = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", good.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  /** code → the nonce and PKCE challenge it was issued for (filled by the test from the authorize URL). */
  const fg: FakeGoogle & { codes: Map<string, { nonce: string; challenge: string }> } = {
    clientId: opts.clientId,
    next: {},
    calls: [],
    codes: new Map(),
    async fetch(url, init) {
      fg.calls.push(url);
      if (url === opts.jwksUrl) return Response.json({ keys: [jwk] }, { headers: { "cache-control": "public, max-age=3600" } });
      if (url === opts.tokenUrl) {
        const form = new URLSearchParams(String(init?.body ?? ""));
        const issued = fg.codes.get(form.get("code") ?? "");
        if (fg.next.error || !issued) return Response.json({ error: fg.next.error ?? "invalid_grant" }, { status: 400 });
        // PKCE: the verifier must hash to the challenge from the authorize request.
        const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") ?? ""))).toString("base64url");
        if (digest !== issued.challenge) return Response.json({ error: "invalid_grant", error_description: "PKCE mismatch" }, { status: 400 });
        if (form.get("client_id") !== opts.clientId || !form.get("client_secret")) return Response.json({ error: "invalid_client" }, { status: 401 });
        const now = Math.floor(Date.now() / 1000);
        const claims = {
          iss: "https://accounts.google.com",
          aud: opts.clientId,
          sub: "sub-default",
          email: "someone@example.com",
          email_verified: true,
          name: "Someone",
          picture: "https://example.com/a.png",
          iat: now,
          exp: now + 3600,
          nonce: issued.nonce,
          ...fg.next.claims,
        };
        const head = b64({ alg: "RS256", kid: fg.next.kid ?? "k1", typ: "JWT" });
        const body = b64(claims);
        const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", (fg.next.badKey ? bad : good).privateKey, new TextEncoder().encode(`${head}.${body}`));
        return Response.json({ id_token: `${head}.${body}.${Buffer.from(sig).toString("base64url")}`, access_token: "x" });
      }
      return new Response("not found", { status: 404 });
    },
  };
  return fg;
}

/**
 * Sign in through /auth/google with the fake provider: returns the callback response (and the session cookie if
 * one was set). `tamper` can change the callback's state.
 */
export async function googleSignIn(
  base: string,
  fg: FakeGoogle,
  claims: Record<string, unknown>,
  opts: { next?: string; badKey?: boolean; kid?: string; tamperState?: boolean; nonce?: string; session?: string; callbackSession?: string } = {},
): Promise<{ res: Response; cookie: string | null; location: string | null }> {
  // `session`: a signed-in browser's session cookie, sent at both steps (`callbackSession` overrides the second).
  const start = await fetch(`${base}/auth/google${opts.next !== undefined ? `?next=${encodeURIComponent(opts.next)}` : ""}`, {
    headers: opts.session ? { cookie: opts.session } : {},
    redirect: "manual",
  });
  if (start.status !== 303) throw new Error(`start: ${start.status}`);
  const auth = new URL(start.headers.get("location")!);
  const state = auth.searchParams.get("state")!;
  const code = `code-${Math.random()}`;
  (fg as unknown as { codes: Map<string, { nonce: string; challenge: string }> }).codes.set(code, {
    nonce: opts.nonce ?? auth.searchParams.get("nonce")!,
    challenge: auth.searchParams.get("code_challenge")!,
  });
  fg.next = { claims, badKey: opts.badKey, kid: opts.kid };
  const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith("np_google_state="))!.split(";")[0]!;
  const res = await fetch(`${base}/auth/google/callback?state=${opts.tamperState ? "x" + state : state}&code=${encodeURIComponent(code)}`, {
    headers: { cookie: [stateCookie, opts.callbackSession ?? opts.session].filter(Boolean).join("; ") },
    redirect: "manual",
  });
  const session = res.headers.getSetCookie().find((c) => c.startsWith("np_session=") && !c.includes("Max-Age=0"));
  return { res, cookie: session ? session.split(";")[0]! : null, location: res.headers.get("location") };
}

// ---- room client ----

export interface RoomClient {
  doc: Y.Doc;
  text: Y.Text;
  controls: any[];
  closeCode: number | null;
  opened: Promise<void>;
  close(): void;
}

/** A Yjs room client on /ws with the given query and headers. */
export function room(base: string, query: Record<string, string>, headers: Record<string, string>): RoomClient {
  const doc = new Y.Doc();
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws?${new URLSearchParams(query)}`, { headers } as any);
  ws.binaryType = "arraybuffer";
  const c: RoomClient = {
    doc,
    text: doc.getText("md"),
    controls: [],
    closeCode: null,
    opened: new Promise((r) => ws.addEventListener("open", () => r())),
    close: () => ws.close(),
  };
  const send = (enc: encoding.Encoder) => ws.readyState === 1 && ws.send(encoding.toUint8Array(enc));
  ws.addEventListener("open", () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeSyncStep1(enc, doc);
    send(enc);
  });
  ws.addEventListener("close", (e) => (c.closeCode = e.code));
  ws.addEventListener("message", (e) => {
    const dec = decoding.createDecoder(new Uint8Array(e.data as ArrayBuffer));
    const type = decoding.readVarUint(dec);
    if (type === 0) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.readSyncMessage(dec, enc, doc, "remote");
      if (encoding.length(enc) > 1) send(enc);
    } else if (type === 2) {
      c.controls.push(JSON.parse(decoding.readVarString(dec)));
    }
  });
  doc.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, u);
    send(enc);
  });
  return c;
}

/** Connect and wait for the hello (or a close). */
export async function roomHello(base: string, query: Record<string, string>, headers: Record<string, string>) {
  const c = room(base, query, headers);
  await waitFor(() => c.closeCode !== null || c.controls.some((m) => m.t === "hello"));
  return { client: c, hello: c.controls.find((m) => m.t === "hello") as { readOnly: boolean } | undefined };
}

/**
 * Test files share one DATA_DIR (and maybe one module registry): remember the config and the users that exist now,
 * and put both back afterwards, so other files still see their own config and users.
 */
export function isolate(config: Record<string, any>, db: { query(sql: string): { all(...a: any[]): unknown[]; run(...a: any[]): unknown } }) {
  const saved = structuredClone(config);
  const users = new Set((db.query("SELECT id FROM users").all() as Array<{ id: string }>).map((u) => u.id));
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(config[k], v);
      else config[k] = v;
    }
    for (const { id } of db.query("SELECT id FROM users").all() as Array<{ id: string }>) if (!users.has(id)) db.query("DELETE FROM users WHERE id = ?").run(id);
  };
}
