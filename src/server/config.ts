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
  // Comma-separated GitHub logins allowed to sign in, or "*" for anyone. Empty: only the first user (admin).
  allowedUsers: env("ALLOWED_GITHUB_USERS").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  allowDevLogin: env("ALLOW_DEV_LOGIN") === "1",
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

/**
 * Edits to a linked GitHub repo only reach GitHub through Code Storage's sync, which needs the GitHub App.
 * Without both, GitHub repos are read-only copies.
 */
export function canEditGitHub(): boolean {
  return config.storage === "codestorage" && !!config.github.appSlug;
}
