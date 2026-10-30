// A fake Google (OpenID Connect) for e2e tests: an account chooser page (type an email), the token endpoint
// (an RS256 id_token with the nonce from the sign-in request) and the key set. Point the server at it with
// fakeGoogleEnv(fake). Also serves /app/* as a stand-in "other Grim server" page.

export async function startFakeGoogle() {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  const kid = "fake-1";
  const codes = new Map();
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  let origin = "";

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/auth") {
        // the account chooser: the test types an email and continues
        const q = Object.fromEntries(url.searchParams);
        const hidden = ["redirect_uri", "state", "nonce", "client_id"].map((k) => `<input type="hidden" name="${k}" value="${(q[k] ?? "").replace(/"/g, "&quot;")}">`).join("");
        return new Response(
          `<!doctype html><title>Fake Google</title><form method="post" action="/choose">${hidden}<input name="email" id="email" placeholder="email"><input name="name" id="name" placeholder="name"><button id="go">Continue</button></form>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url.pathname === "/choose" && req.method === "POST") {
        const f = await req.formData();
        const code = crypto.randomUUID();
        const email = String(f.get("email"));
        codes.set(code, { email, name: String(f.get("name") || email.split("@")[0]), nonce: String(f.get("nonce")), aud: String(f.get("client_id")) });
        const back = new URL(String(f.get("redirect_uri")));
        back.searchParams.set("code", code);
        back.searchParams.set("state", String(f.get("state")));
        return Response.redirect(back.toString(), 302);
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const f = new URLSearchParams(await req.text());
        const c = codes.get(f.get("code") ?? "");
        if (!c) return Response.json({ error: "invalid_grant" }, { status: 400 });
        codes.delete(f.get("code"));
        const now = Math.floor(Date.now() / 1000);
        const head = b64({ alg: "RS256", kid, typ: "JWT" });
        const body = b64({ iss: origin, aud: c.aud, sub: `sub-${c.email}`, email: c.email, email_verified: true, name: c.name, nonce: c.nonce, iat: now, exp: now + 600 });
        const sig = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${head}.${body}`))).toString("base64url");
        return Response.json({ id_token: `${head}.${body}.${sig}`, access_token: "x", token_type: "Bearer" });
      }
      if (url.pathname === "/jwks") return Response.json({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] });
      if (url.pathname.startsWith("/app/")) return new Response(`<!doctype html><title>Other server</title><h1 id="other">Another Grim: ${url.pathname}</h1>`, { headers: { "content-type": "text/html" } });
      return new Response("not found", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  return { origin, stop: () => server.stop(true) };
}

/** The server settings that point it at the fake (also set in process.env, for a Bun server in this process). */
export function fakeGoogleEnv(fake) {
  const env = {
    GOOGLE_CLIENT_ID: "fake-client",
    GOOGLE_CLIENT_SECRET: "fake-secret",
    GOOGLE_AUTH_URL: `${fake.origin}/auth`,
    GOOGLE_TOKEN_URL: `${fake.origin}/token`,
    GOOGLE_JWKS_URL: `${fake.origin}/jwks`,
    GOOGLE_ISSUERS: fake.origin,
  };
  Object.assign(process.env, env);
  return env;
}
