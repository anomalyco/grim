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
  // Comma-separated GitHub logins allowed to sign in, or "*" for anyone. Empty: nobody (Google accounts go by SIGNIN).
  allowedUsers: env("ALLOWED_GITHUB_USERS").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  allowDevLogin: env("ALLOW_DEV_LOGIN") === "1",
  // Who may sign in: "open" (anyone; the name-only/guest sign-in works if ALLOW_DEV_LOGIN is on) or "emails" (only
  // Google-verified emails matching ALLOWED_EMAILS: addresses or *@domain; no name-only sign-in).
  signin: (env("SIGNIN", "open").toLowerCase() === "emails" ? "emails" : "open") as "open" | "emails",
  allowedEmails: env("ALLOWED_EMAILS").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
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
  pollMs: Number(env("POLL_MS", "20000")),
  // How often read-only GitHub repos are refreshed from GitHub.
  upstreamRefreshMs: Number(env("UPSTREAM_REFRESH_MS", "300000")),
  // Read-only GitHub copies: how many in total, and how many one person may add.
  githubCopies: { max: Number(env("MAX_GITHUB_REPOS", "100")), perUser: Number(env("MAX_GITHUB_REPOS_PER_USER", "10")) },
};

export type Config = typeof config;

/** The name-only and guest sign-ins: only on open servers, and only with ALLOW_DEV_LOGIN. */
export function devLoginEnabled(): boolean {
  return config.allowDevLogin && config.signin === "open";
}

/**
 * Edits to a linked GitHub repo only reach GitHub through Code Storage's sync, which needs the GitHub App.
 * Without both, GitHub repos are read-only copies.
 */
export function canEditGitHub(): boolean {
  return config.storage === "codestorage" && !!config.github.appSlug;
}
