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
    webhookSecret: secret("CODE_STORAGE_WEBHOOK_SECRET"),
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
  // The name-only sign-in (always a new account).
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
  notesRepo: env("NOTES_REPO", "notes"),
  defaultBranch: env("DEFAULT_BRANCH", "main"),
  quietMs: Number(env("QUIET_MS", "3000")),
  // The demo folder (demo.ts) goes back to its seed this often (0: never, except on restart).
  demoResetHours: Number(env("DEMO_RESET_HOURS", "6")),
  pollMs: Number(env("POLL_MS", "20000")),
  // How often read-only GitHub repos are refreshed from GitHub.
  upstreamRefreshMs: Number(env("UPSTREAM_REFRESH_MS", "300000")),
  // Read-only GitHub copies: how many in total, and how many one person may add.
  githubCopies: { max: Number(env("MAX_GITHUB_REPOS", "100")), perUser: Number(env("MAX_GITHUB_REPOS_PER_USER", "10")) },
};

// Secrets stay readable and writable but are accessors over a closure (not enumerable, shown as [Getter/Setter]):
// logging or serializing config (or a part of it) can't print them.
for (const [obj, key] of [[config.codeStorage, "key"], [config.codeStorage, "webhookSecret"], [config.github, "clientSecret"], [config.google, "clientSecret"]] as const) {
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

export function devLoginEnabled(): boolean {
  return config.allowDevLogin;
}

/**
 * Edits to a linked GitHub repo only reach GitHub through Code Storage's sync, which needs the GitHub App.
 * Without both, GitHub repos are read-only copies.
 */
export function canEditGitHub(): boolean {
  return config.storage === "codestorage" && !!config.github.appSlug;
}
