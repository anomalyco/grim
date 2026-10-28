// Workspaces (the repos table plus link_access, domain_rule, owner_id), their members and email invites, the
// "joined" list, and who may do what. See docs/workspaces/SPEC.md.
import { config } from "./config.ts";
import { db, newId } from "./db.ts";
import type { RepoRow } from "./repos.ts";

export type Role = "owner" | "editor" | "viewer";
export type LinkAccess = "none" | "view" | "edit";
export type Via = "member" | "domain" | "link";

export const ROLES: Role[] = ["owner", "editor", "viewer"];
export const LINK_ACCESS: LinkAccess[] = ["none", "view", "edit"];
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

/** The parts of a user that decide workspace access. */
export interface Who {
  id: string;
  email: string;
  emailVerified: boolean;
}

export interface MemberRow {
  id: string;
  workspace_id: string;
  user_id: string | null;
  email: string | null;
  role: Role;
  invited_by: string | null;
  created_at: number;
}

export function higher(a: Role | null, b: Role | null): Role | null {
  if (!a) return b;
  if (!b) return a;
  return RANK[b] > RANK[a] ? b : a;
}

export const normEmail = (e: string) => e.trim().toLowerCase();
const EMAIL = /^[^\s@,=]+@[^\s@,=]+\.[^\s@,=]+$/;
export const validEmail = (e: string) => EMAIL.test(e) && e.length <= 254;

/** An email matches an entry that is the address itself or `*@domain` (that exact domain). */
export function emailMatches(pattern: string, email: string): boolean {
  const e = normEmail(email);
  const p = normEmail(pattern);
  if (p.startsWith("*@")) return e.endsWith(p.slice(1));
  return p === e;
}

/** Whether the server's SIGNIN=emails policy lets this email in. */
export function emailListed(email: string): boolean {
  return config.allowedEmails.some((p) => emailMatches(p, email));
}

/**
 * A domain rule: comma-separated `pattern=role` entries, pattern `*@domain` or an address, role editor or viewer
 * (e.g. `*@company.com=editor`). Returns the normalized rule, or null if it is invalid.
 */
export function parseDomainRule(raw: string): { rule: string; entries: Array<{ pattern: string; role: Role }> } | null {
  const entries: Array<{ pattern: string; role: Role }> = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\*@[^\s@,=]+\.[^\s@,=]+|[^\s@,=*]+@[^\s@,=]+\.[^\s@,=]+)\s*=\s*(editor|viewer)$/i.exec(part);
    if (!m) return null;
    entries.push({ pattern: m[1]!.toLowerCase(), role: m[2]!.toLowerCase() as Role });
  }
  if (!entries.length || entries.length > 20) return null;
  return { rule: entries.map((e) => `${e.pattern}=${e.role}`).join(","), entries };
}

export function domainRole(rule: string | null, email: string): Role | null {
  if (!rule) return null;
  const parsed = parseDomainRule(rule);
  let role: Role | null = null;
  for (const e of parsed?.entries ?? []) if (emailMatches(e.pattern, email)) role = higher(role, e.role);
  return role;
}

export function linkRole(access: string | null | undefined): Role | null {
  return access === "edit" ? "editor" : access === "view" ? "viewer" : null;
}

export function memberRow(workspaceId: string, userId: string): MemberRow | null {
  return db.query("SELECT * FROM members WHERE workspace_id = ? AND user_id = ?").get(workspaceId, userId) as MemberRow | null;
}

/**
 * The user's role in a workspace and where it comes from: the highest of their membership, the domain rule (verified
 * emails only) and the workspace's link access. Ties go to the first of those. Nobody has access to every workspace.
 */
export function workspaceRole(u: Who, repo: RepoRow): { role: Role | null; via: Via | null } {
  let role: Role | null = null;
  let via: Via | null = null;
  const consider = (r: Role | null, v: Via) => {
    if (r && (!role || RANK[r] > RANK[role])) {
      role = r;
      via = v;
    }
  };
  consider(memberRow(repo.id, u.id)?.role ?? null, "member");
  if (u.emailVerified) consider(domainRole(repo.domain_rule, u.email), "domain");
  consider(linkRole(repo.link_access), "link");
  return { role, via };
}

/** What a role may do in a workspace: owners and editors write (unless the workspace is read-only), viewers read. */
export function roleAccess(role: Role | null, repo: RepoRow): "write" | "read" | "none" {
  if (!role) return "none";
  if (role === "viewer" || repo.read_only) return "read";
  return "write";
}

/**
 * Opening a workspace while signed in records it in the user's joined list when their access comes from link access
 * or a domain rule (members are listed anyway). Returns whether anything was recorded.
 */
export function recordJoin(u: Who, repo: RepoRow): boolean {
  if (memberRow(repo.id, u.id)) return false;
  const domain = u.emailVerified ? domainRole(repo.domain_rule, u.email) : null;
  const link = linkRole(repo.link_access);
  if (!domain && !link) return false;
  const via = domain && (!link || RANK[domain] >= RANK[link]) ? "domain" : "link";
  db.query("INSERT INTO joined (workspace_id, user_id, via, joined_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET via = excluded.via").run(
    repo.id,
    u.id,
    via,
    Date.now(),
  );
  return true;
}

export class WorkspaceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const ownerCount = (workspaceId: string) =>
  (db.query("SELECT COUNT(*) AS n FROM members WHERE workspace_id = ? AND role = 'owner' AND user_id IS NOT NULL").get(workspaceId) as { n: number }).n;

/** Leave a workspace: drop it from the joined list, and end a membership (the last owner can't leave). */
export const leave = db.transaction((u: Who, workspaceId: string): void => {
  const m = memberRow(workspaceId, u.id);
  if (m?.role === "owner" && ownerCount(workspaceId) <= 1) throw new WorkspaceError(409, "you're the last owner; add another owner first");
  if (m) db.query("DELETE FROM members WHERE id = ?").run(m.id);
  db.query("DELETE FROM joined WHERE workspace_id = ? AND user_id = ?").run(workspaceId, u.id);
});

/** The workspaces a user has joined: memberships, plus joined entries they can still open. */
export function joinedRows(u: Who): Array<{ repo: RepoRow; via: "member" | "domain" | "link" }> {
  const rows = db
    .query(
      `SELECT r.*, 'member' AS joined_via FROM members m JOIN repos r ON r.id = m.workspace_id WHERE m.user_id = ?1
       UNION ALL
       SELECT r.*, j.via AS joined_via FROM joined j JOIN repos r ON r.id = j.workspace_id
       WHERE j.user_id = ?1 AND NOT EXISTS (SELECT 1 FROM members m WHERE m.workspace_id = j.workspace_id AND m.user_id = ?1)
       ORDER BY r.kind DESC, r.title`,
    )
    .all(u.id) as Array<RepoRow & { joined_via: "member" | "domain" | "link" }>;
  const out: Array<{ repo: RepoRow; via: "member" | "domain" | "link" }> = [];
  for (const { joined_via, ...repo } of rows) {
    if (joined_via === "member") {
      out.push({ repo, via: "member" });
      continue;
    }
    // Joined through access that's gone (link access turned off, rule changed): no longer listed.
    const { via } = workspaceRole(u, repo);
    if (via === "domain" || via === "link") out.push({ repo, via });
  }
  return out;
}

// ---- members and invites ----

export interface MemberInfo {
  id: string;
  userId: string | null;
  email: string | null;
  name: string | null;
  avatar: string | null;
  role: Role;
  pending: boolean;
  invitedBy: string | null;
  createdAt: number;
}

export function listMembers(workspaceId: string): MemberInfo[] {
  const rows = db
    .query(
      `SELECT m.*, u.name AS user_name, u.email AS user_email, u.avatar AS user_avatar FROM members m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ? ORDER BY m.created_at, m.id`,
    )
    .all(workspaceId) as Array<MemberRow & { user_name: string | null; user_email: string | null; user_avatar: string | null }>;
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    email: r.user_email ?? r.email,
    name: r.user_name,
    avatar: r.user_avatar,
    role: r.role,
    pending: !r.user_id,
    invitedBy: r.invited_by,
    createdAt: r.created_at,
  }));
}

export function addOwner(workspaceId: string, userId: string) {
  db.query("INSERT INTO members (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?) ON CONFLICT DO UPDATE SET role = 'owner'").run(
    newId("m_"),
    workspaceId,
    userId,
    Date.now(),
  );
}

/**
 * Invite an email with a role, or change the role of whoever has it. Someone already signed up with that verified
 * email becomes a member at once; otherwise it's an invite until they sign in. The last owner can't be demoted.
 */
export const setMember = db.transaction((workspaceId: string, rawEmail: string, role: Role, invitedBy: string): MemberRow => {
  const email = normEmail(rawEmail);
  if (!validEmail(email)) throw new WorkspaceError(400, "enter a valid email address");
  if (!ROLES.includes(role)) throw new WorkspaceError(400, "role must be owner, editor or viewer");
  const user = db.query("SELECT id FROM users WHERE lower(email) = ? AND email_verified = 1 ORDER BY created_at LIMIT 1").get(email) as { id: string } | null;
  if (user) {
    const existing = memberRow(workspaceId, user.id);
    db.query("DELETE FROM members WHERE workspace_id = ? AND email = ? AND user_id IS NULL").run(workspaceId, email);
    if (existing) {
      if (existing.role === "owner" && role !== "owner" && ownerCount(workspaceId) <= 1) throw new WorkspaceError(409, "a folder needs an owner; add another owner first");
      db.query("UPDATE members SET role = ? WHERE id = ?").run(role, existing.id);
      return { ...existing, role };
    }
    const row: MemberRow = { id: newId("m_"), workspace_id: workspaceId, user_id: user.id, email, role, invited_by: invitedBy, created_at: Date.now() };
    db.query("INSERT INTO members (id, workspace_id, user_id, email, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      row.id,
      row.workspace_id,
      row.user_id,
      row.email,
      row.role,
      row.invited_by,
      row.created_at,
    );
    db.query("DELETE FROM joined WHERE workspace_id = ? AND user_id = ?").run(workspaceId, user.id);
    return row;
  }
  const invite = db.query("SELECT * FROM members WHERE workspace_id = ? AND email = ? AND user_id IS NULL").get(workspaceId, email) as MemberRow | null;
  if (invite) {
    db.query("UPDATE members SET role = ? WHERE id = ?").run(role, invite.id);
    return { ...invite, role };
  }
  const row: MemberRow = { id: newId("m_"), workspace_id: workspaceId, user_id: null, email, role, invited_by: invitedBy, created_at: Date.now() };
  db.query("INSERT INTO members (id, workspace_id, user_id, email, role, invited_by, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)").run(
    row.id,
    row.workspace_id,
    row.email,
    row.role,
    row.invited_by,
    row.created_at,
  );
  return row;
});

/** Remove a member or invite (not the last owner). */
export const removeMember = db.transaction((workspaceId: string, memberId: string): void => {
  const m = db.query("SELECT * FROM members WHERE id = ? AND workspace_id = ?").get(memberId, workspaceId) as MemberRow | null;
  if (!m) throw new WorkspaceError(404, "member not found");
  if (m.role === "owner" && m.user_id && ownerCount(workspaceId) <= 1) throw new WorkspaceError(409, "a folder needs an owner; you can't remove the last one");
  db.query("DELETE FROM members WHERE id = ?").run(m.id);
});

/** On sign-in with a verified email: its pending invites become memberships (keeping the higher role). */
export const claimInvites = db.transaction((userId: string, rawEmail: string): number => {
  const email = normEmail(rawEmail);
  const invites = db.query("SELECT * FROM members WHERE email = ? AND user_id IS NULL").all(email) as MemberRow[];
  for (const inv of invites) {
    const existing = memberRow(inv.workspace_id, userId);
    if (existing) {
      db.query("UPDATE members SET role = ? WHERE id = ?").run(higher(existing.role, inv.role), existing.id);
      db.query("DELETE FROM members WHERE id = ?").run(inv.id);
    } else {
      db.query("UPDATE members SET user_id = ? WHERE id = ?").run(userId, inv.id);
    }
    db.query("DELETE FROM joined WHERE workspace_id = ? AND user_id = ?").run(inv.workspace_id, userId);
  }
  return invites.length;
});
