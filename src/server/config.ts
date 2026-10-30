import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function secret(name: string): string {
  const file = env(`${name}_FILE`);
  if (file) return readFileSync(file, "utf8");
  return (process.env[name] ?? "").replace(/\\n/g, "\n");
}

const codeStorageOrg = env("CODE_STORAGE_ORG");
const codeStorageKey = secret("CODE_STORAGE_PRIVATE_KEY");

export const config = {
  port: Number(env("PORT", "8787")),
  publicUrl: env("PUBLIC_URL", `http://localhost:${env("PORT", "8787")}`).replace(/\/$/, ""),
  // Reverse proxies whose X-Forwarded-* headers are believed (IPs/CIDRs, or "none"). exe.dev's proxy connects from
  // loopback on the VM. See proxy.ts.
  trustedProxies: env("TRUSTED_PROXIES", "127.0.0.0/8,::1"),
  dataDir: resolve(env("DATA_DIR", "./data")),
  storage: (env("STORAGE") || (codeStorageOrg && codeStorageKey ? "codestorage" : "local")) as "codestorage" | "local",
  codeStorage: {
    org: codeStorageOrg,
    key: codeStorageKey,
    apiBaseUrl: env("CODE_STORAGE_API_URL") || undefined,
    storageBaseUrl: env("CODE_STORAGE_GIT_URL") || undefined,
    // Prepended to every repo id sent to Code Storage (e.g. "stg-" for staging, which shares production's org).
    repoPrefix: env("CODE_STORAGE_REPO_PREFIX"),
  },
  github: {
    clientId: env("GITHUB_CLIENT_ID"),
    clientSecret: secret("GITHUB_CLIENT_SECRET"),
    appSlug: env("GITHUB_APP_SLUG"),
    // Where GitHub repos are cloned from in local mode (tests point it at file:// repos).
    gitBase: env("GITHUB_GIT_BASE", "https://github.com").replace(/\/$/, ""),
  },
  // Cache session and app-token lookups in memory (auth.ts): on for Workers, off by default on Bun.
  authCache: env("AUTH_CACHE") === "1",
  // Cache workspace rows read by id for 10 s (repo-cache.ts): on for Workers, off by default on Bun.
  repoCache: env("REPO_CACHE") === "1",
  // SIGN_IN=on|off (docs/self-hosting.md "Sign-in"). off, the default: no accounts at all, every visitor may do
  // everything (sign-in routes answer 404 or go home). on: accounts through Google (GitHub too where configured);
  // guests only read and edit notes, and the server refuses to start without a sign-in method (auth.ts signInProblem).
  signIn: /^(on|true|1|yes)$/i.test(env("SIGN_IN")),
  // MARKETING_SITE=on|off: our hosted site's landing page at "/" (the big intro note, "Get started", and the pencils:
  // yours and three bots', all in the browser: src/client/landing). off, the default (self-hosted): "/" is the app.
  marketingSite: /^(on|true|1|yes)$/i.test(env("MARKETING_SITE")),
  /** SIGN_IN as written (checked by signInProblem). */
  signInSetting: env("SIGN_IN"),
  // Test hook, not a sign-in method: POST /auth/dev makes a new account with a typed name (test and dev servers on
  // plain http only; never on an https PUBLIC_URL). With SIGN_IN=on, sign-in is Google (or GitHub where configured).
  allowDevLogin: env("ALLOW_DEV_LOGIN") === "1",
  google: {
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: secret("GOOGLE_CLIENT_SECRET").trim(),
    // Overridable so a fake provider can stand in (tests, local development).
    authUrl: env("GOOGLE_AUTH_URL", "https://accounts.google.com/o/oauth2/v2/auth"),
    tokenUrl: env("GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token"),
    jwksUrl: env("GOOGLE_JWKS_URL", "https://www.googleapis.com/oauth2/v3/certs"),
    issuers: env("GOOGLE_ISSUERS", "https://accounts.google.com,accounts.google.com").split(",").map((s) => s.trim()).filter(Boolean),
  },
  // Shown to clients (GET /api/server); defaults to PUBLIC_URL's host.
  serverName: env("SERVER_NAME"),
  defaultBranch: env("DEFAULT_BRANCH", "main"),
  quietMs: Number(env("QUIET_MS", "3000")),
  // Workspaces where guests (signed out) may also create, rename and delete notes and folders and upload images, not
  // only edit notes: comma list of ids, default the demo (the public playground). "" = none.
  guestCreate: new Set((process.env.GUEST_CREATE_WORKSPACES ?? "demo").split(",").map((s: string) => s.trim()).filter(Boolean)),
  // The demo folder (demo.ts) goes back to its seed this often, in minutes (0: never, except on restart).
  // DEMO_RESET_MINUTES wins; the older DEMO_RESET_HOURS still works when it isn't set. Default 15 minutes.
  demoResetMinutes: env("DEMO_RESET_MINUTES") ? Number(env("DEMO_RESET_MINUTES")) : env("DEMO_RESET_HOURS") ? Number(env("DEMO_RESET_HOURS")) * 60 : 15,
  // How often read-only GitHub repos are refreshed from GitHub.
  upstreamRefreshMs: Number(env("UPSTREAM_REFRESH_MS", "300000")),
  // Read-only GitHub copies: how many in total, and how many one person may add.
  githubCopies: { max: Number(env("MAX_GITHUB_REPOS", "100")), perUser: Number(env("MAX_GITHUB_REPOS_PER_USER", "10")) },
};

// Secrets stay readable and writable but are accessors over a closure (not enumerable, shown as [Getter/Setter]):
// logging or serializing config (or a part of it) can't print them.
for (const [obj, key] of [[config.codeStorage, "key"], [config.github, "clientSecret"], [config.google, "clientSecret"]] as const) {
  let value = (obj as Record<string, string>)[key];
  Object.defineProperty(obj, key, { get: () => value, set: (v: string) => (value = v), enumerable: false, configurable: true });
}

export type Config = typeof config;

/** Test processes (test/local-storage.ts sets GRIMOIRE_TEST) must never reach Code Storage. */
export function assertTestStorage(): void {
  if (process.env.GRIMOIRE_TEST && config.storage !== "local") {
    throw new Error(`refusing to start a test server with STORAGE=${config.storage}: tests must use STORAGE=local (see test/local-storage.ts)`);
  }
}

/**
 * Guests may create, rename, delete and upload in this workspace (GUEST_CREATE_WORKSPACES; else they only edit).
 * With sign-in off everyone may, everywhere.
 */
export function guestCreate(repoId: string): boolean {
  // (every demo room is "demo": demo-rooms.ts)
  return !config.signIn || config.guestCreate.has(/^demo\.[a-z0-9]{10}$/.test(repoId) ? "demo" : repoId);
}

/** The test sign-in (/auth/dev): ALLOW_DEV_LOGIN=1 on a plain-http server only, so never on a real deployment. */
export function devLoginEnabled(): boolean {
  return config.signIn && config.allowDevLogin && config.publicUrl.startsWith("http://");
}

/**
 * Edits to a linked GitHub repo only reach GitHub through Code Storage's sync, which needs the GitHub App.
 * Without both, GitHub repos are read-only copies.
 */
export function canEditGitHub(): boolean {
  return config.storage === "codestorage" && !!config.github.appSlug;
}
