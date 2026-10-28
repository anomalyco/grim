// Workspaces: remote workspace URLs, the remembered workspaces on other servers, and the workspace dialogs
// (open/create, share workspace, share note, settings).
import { api, ApiError, type AppToken, type Config, type LinkAccess, type Member, type Role, type WorkspaceDetails } from "./api.ts";
import { copyButton, copyText, gitHubForm, modal, type AddGitHubHooks, type DialogHost } from "./dialogs.ts";
import { clear, errorMessage, h, initials, colorFor, relativeTime, toast } from "./util.ts";

// ---------- remote workspace URLs ----------

export interface WorkspaceRef {
  /** The server's origin, e.g. https://grimoire.example.com */
  origin: string;
  workspace: string;
  /** A note path from the URL, if it had one. */
  path: string | null;
}

/** A pasted workspace URL (`https://server/app/<workspace>[/<path>]`, old `/r/` links too); null if it isn't one. */
export function parseWorkspaceUrl(raw: string): WorkspaceRef | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = (/^(localhost|127\.|\[::1\])/.test(s) ? "http://" : "https://") + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const m = u.pathname.match(/^\/(?:app|r)\/([^/]+)(?:\/(.*))?$/);
  if (!m) return null;
  try {
    const workspace = decodeURIComponent(m[1]!);
    const path = m[2] ? m[2].split("/").filter(Boolean).map(decodeURIComponent).join("/") : "";
    if (!workspace || workspace === "." || workspace === "..") return null;
    return { origin: u.origin, workspace, path: path || null };
  } catch {
    return null;
  }
}

export function workspaceUrl(ref: { origin: string; workspace: string; path?: string | null }) {
  return `${ref.origin}/app/${encodeURIComponent(ref.workspace)}` + (ref.path ? "/" + ref.path.split("/").map(encodeURIComponent).join("/") : "");
}

export const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

// ---------- workspaces on other servers (this browser remembers them) ----------

export interface RemoteWorkspace {
  origin: string;
  workspace: string;
  title?: string;
  addedAt: number;
}

const REMOTE_KEY = "grimoire.remoteWorkspaces.v1";

export function rememberedRemotes(here = location.origin): RemoteWorkspace[] {
  try {
    const raw = JSON.parse(localStorage.getItem(REMOTE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is RemoteWorkspace => !!r && typeof r.origin === "string" && typeof r.workspace === "string" && r.origin !== here);
  } catch {
    return [];
  }
}

export function rememberRemote(ref: { origin: string; workspace: string; title?: string }) {
  const rest = rememberedRemotes("").filter((r) => !(r.origin === ref.origin && r.workspace === ref.workspace));
  const list = [{ origin: ref.origin, workspace: ref.workspace, ...(ref.title ? { title: ref.title } : {}), addedAt: Date.now() }, ...rest].slice(0, 50);
  try {
    localStorage.setItem(REMOTE_KEY, JSON.stringify(list));
  } catch {}
}

export function forgetRemote(ref: { origin: string; workspace: string }) {
  const list = rememberedRemotes("").filter((r) => !(r.origin === ref.origin && r.workspace === ref.workspace));
  try {
    localStorage.setItem(REMOTE_KEY, JSON.stringify(list));
  } catch {}
}

// ---------- notes shared with me by link (this browser remembers the ones I added) ----------

export interface SharedNote {
  url: string;
  title: string;
  workspace: string;
  host: string;
  addedAt: number;
}

const SHARED_KEY = "grimoire.sharedNotes.v1";

export function sharedNotes(user: string): SharedNote[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SHARED_KEY) ?? "null") as { user?: string; notes?: unknown } | null;
    if (raw?.user !== user || !Array.isArray(raw.notes)) return [];
    return raw.notes.filter((n): n is SharedNote => !!n && typeof n.url === "string" && typeof n.title === "string");
  } catch {
    return [];
  }
}

export function rememberSharedNote(user: string, note: Omit<SharedNote, "addedAt">) {
  const list = [{ ...note, addedAt: Date.now() }, ...sharedNotes(user).filter((n) => n.url !== note.url)].slice(0, 50);
  try {
    localStorage.setItem(SHARED_KEY, JSON.stringify({ user, notes: list }));
  } catch {}
}

export function forgetSharedNote(user: string, url: string) {
  const list = sharedNotes(user).filter((n) => n.url !== url);
  try {
    localStorage.setItem(SHARED_KEY, JSON.stringify({ user, notes: list }));
  } catch {}
}

// ---------- dialogs ----------

export type OpenChoice = "open-remote" | "open-github" | "create-remote";

export interface OpenHooks extends AddGitHubHooks {
  /** A remote folder URL to open (this server or another). */
  openRemote(ref: WorkspaceRef): void;
  /** Create a folder on this server and open it; throws to show the error in the dialog. */
  create(title: string): Promise<void>;
}

/**
 * "Open…": one dialog for opening a remote folder by URL, adding a GitHub repo, or creating a remote folder.
 * The choices are a list on the left (sections "Open" and "Create new"), the chosen form on the right.
 */
export function openDialog(config: Config, hooks: OpenHooks, start: OpenChoice = "open-remote") {
  let open = true;
  const host: DialogHost = { close: () => dlg.close(), isOpen: () => open };
  const panes: Record<OpenChoice, { form: HTMLElement; focus(): void }> = {
    "open-remote": remoteForm(hooks, host),
    "open-github": gitHubForm(config, hooks, host),
    "create-remote": createForm(hooks, host),
  };
  const tabs = new Map<OpenChoice, HTMLButtonElement>();
  const tab = (choice: OpenChoice, label: string) => {
    const b = h("button", { type: "button", class: "open-choice", role: "tab", id: `open-tab-${choice}`, "aria-controls": `open-pane-${choice}`, "data-choice": choice, onclick: () => pick(choice, true) }, label) as HTMLButtonElement;
    tabs.set(choice, b);
    return b;
  };
  const nav = h("div", { class: "open-nav", role: "tablist", "aria-orientation": "vertical", "aria-label": "What to open" },
    h("div", { class: "open-section" }, "Open"),
    tab("open-remote", "Remote folder"),
    tab("open-github", "GitHub repo"),
    h("div", { class: "open-section" }, "Create new"),
    tab("create-remote", "Remote folder"),
  );
  nav.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const order = [...tabs.keys()];
    const i = order.findIndex((c) => tabs.get(c) === document.activeElement);
    const next = order[(i + (e.key === "ArrowDown" ? 1 : order.length - 1)) % order.length]!;
    pick(next, false);
    tabs.get(next)!.focus();
  });
  for (const [choice, p] of Object.entries(panes)) {
    p.form.classList.add("open-pane");
    p.form.id = `open-pane-${choice}`;
    p.form.setAttribute("role", "tabpanel");
    p.form.setAttribute("aria-labelledby", `open-tab-${choice}`);
  }
  const body = h("div", { class: "open-dlg" }, nav, h("div", { class: "open-panes" }, ...Object.values(panes).map((p) => p.form)));
  function pick(choice: OpenChoice, focusField: boolean) {
    for (const [c, b] of tabs) {
      b.setAttribute("aria-selected", String(c === choice));
      b.tabIndex = c === choice ? 0 : -1;
      panes[c].form.hidden = c !== choice;
    }
    if (focusField) panes[choice].focus();
  }
  const dlg = modal("Open", body, { wide: true });
  dlg.classList.add("open-modal");
  dlg.addEventListener("close", () => (open = false));
  pick(start, true);
}

function remoteForm(hooks: OpenHooks, host: DialogHost) {
  const input = h("input", { type: "text", placeholder: "https://grimoire.example.com/app/notes", required: true, autocomplete: "off", spellcheck: "false", "aria-label": "Folder URL" });
  const error = h("p", { class: "form-error", hidden: true, role: "alert" });
  const form = h("form", { class: "modal-body" },
    h("label", { class: "field" }, h("span", null, "Folder URL"), input),
    h("p", { class: "hint" }, "Paste the link to a folder on any Grimoire server (a link to one of its notes works too)."),
    error,
    h("div", { class: "modal-actions" },
      h("button", { type: "button", class: "btn", onclick: () => host.close() }, "Cancel"),
      h("button", { type: "submit", class: "btn btn-primary" }, "Open"),
    ),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const ref = parseWorkspaceUrl(input.value);
    if (!ref) {
      error.textContent = "That isn't a folder link. It looks like https://server/app/folder.";
      error.hidden = false;
      return;
    }
    host.close();
    hooks.openRemote(ref);
  });
  return { form, focus: () => input.focus() };
}

function createForm(hooks: OpenHooks, host: DialogHost) {
  const input = h("input", { type: "text", required: true, autocomplete: "off", spellcheck: "false", "aria-label": "Name" });
  const error = h("p", { class: "form-error", hidden: true, role: "alert" });
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, "Create") as HTMLButtonElement;
  const form = h("form", { class: "modal-body" },
    h("label", { class: "field" }, h("span", null, "Name"), input),
    h("p", { class: "hint" }, `A folder of Markdown notes on ${location.host}. Only you can open it until you share it.`),
    error,
    h("div", { class: "modal-actions" },
      h("button", { type: "button", class: "btn", onclick: () => host.close() }, "Cancel"),
      submit,
    ),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = input.value.trim();
    if (!title || submit.disabled) return;
    submit.disabled = true;
    error.hidden = true;
    try {
      await hooks.create(title);
      host.close();
    } catch (err) {
      if (!host.isOpen()) return toast(errorMessage(err), "error");
      error.textContent = errorMessage(err);
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  return { form, focus: () => input.focus() };
}

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", editor: "Can edit", viewer: "Can view" };

function select<T extends string>(value: T, options: [T, string][], label: string, onchange?: (v: T) => void) {
  const el = h("select", { class: "select", "aria-label": label }, options.map(([v, l]) => h("option", { value: v, selected: v === value ? true : undefined }, l)));
  el.value = value;
  if (onchange) el.addEventListener("change", () => onchange(el.value as T));
  return el;
}

/** "Share workspace" (owners): people by email with a role, pending invites, link access, a domain rule, the link. */
export function shareWorkspaceDialog(ws: { id: string; title: string }, onChange?: () => void, opts: { google?: boolean } = {}) {
  const body = h("div", { class: "modal-body share-ws" }, h("p", { class: "muted" }, "Loading…"));
  modal(`Share “${ws.title}”`, body, { wide: true });
  const link = `${location.origin}/app/${encodeURIComponent(ws.id)}`;
  let details: WorkspaceDetails | null = null;
  let members: Member[] = [];
  const error = h("p", { class: "form-error", hidden: true, role: "alert" });
  const showError = (err: unknown) => {
    error.textContent = errorMessage(err);
    error.hidden = false;
  };

  const load = async () => {
    try {
      [details, members] = await Promise.all([api.workspace(ws.id), api.members(ws.id).catch((err) => (err instanceof ApiError && err.status === 404 ? [] : Promise.reject(err)))]);
      if (!members.length && details.members) members = details.members;
      error.hidden = true;
      render();
    } catch (err) {
      clear(body, h("p", { class: "form-error" }, errorMessage(err)));
    }
  };

  const email = h("input", { type: "text", inputmode: "email", placeholder: "name@example.com", autocomplete: "off", spellcheck: "false", "aria-label": "Email address" });
  const role = select<Role>("editor", [["editor", "Can edit"], ["viewer", "Can view"]], "Role for the invite");
  const invite = h("form", { class: "invite-row" }, email, role, h("button", { type: "submit", class: "btn btn-primary" }, "Invite"));
  invite.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = email.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return showError("Enter an email address.");
    try {
      await api.setMember(ws.id, v, role.value as Role);
      email.value = "";
      await load();
      onChange?.();
      email.focus();
    } catch (err) {
      showError(err);
    }
  });

  const render = () => {
    if (!details) return;
    const d = details;
    const owners = members.filter((m) => m.role === "owner" && !m.pending).length;
    const rows = members.map((m) => {
      const pending = m.pending ?? !m.userId;
      const who = m.name || m.email || "Someone";
      const lastOwner = m.role === "owner" && owners <= 1;
      return h("li", { class: "member", "data-email": m.email ?? "" },
        h("span", { class: "avatar avatar-md", style: { "--c": colorFor(m.userId ?? m.email ?? m.id) } }, m.avatar && /^https:\/\//.test(m.avatar) ? h("img", { src: m.avatar, alt: "" }) : initials(who)),
        h("span", { class: "member-who" },
          h("span", { class: "member-name" }, who),
          m.name && m.email ? h("span", { class: "member-email" }, m.email) : null,
        ),
        pending ? h("span", { class: "badge" }, "Invited") : null,
        lastOwner
          ? h("span", { class: "member-role" }, ROLE_LABEL.owner)
          : select<Role>(m.role, [["owner", "Owner"], ["editor", "Can edit"], ["viewer", "Can view"]], `Role for ${who}`, async (v) => {
              try {
                await api.setMember(ws.id, m.email ?? "", v);
                await load();
              } catch (err) {
                showError(err);
                await load();
              }
            }),
        lastOwner ? null : h("button", { type: "button", class: "icon-btn member-remove", title: "Remove", "aria-label": `Remove ${who}`, onclick: async () => {
          try {
            await api.removeMember(ws.id, m.id);
            await load();
            onChange?.();
          } catch (err) {
            showError(err);
          }
        } }, "×"),
      );
    });

    const access = select<LinkAccess>(d.linkAccess, [["none", "Only people added"], ["view", "Anyone with the link can view"], ["edit", "Anyone with the link can edit"]], "Link access", async (v) => {
      try {
        details = await api.updateWorkspace(ws.id, { linkAccess: v });
        render();
        onChange?.();
      } catch (err) {
        showError(err);
      }
    });

    const [domainPart, domainRole] = (d.domainRule ?? "").split("=");
    const domain = h("input", { type: "text", value: domainPart ?? "", placeholder: "*@company.com", autocomplete: "off", spellcheck: "false", "aria-label": "Email domain" });
    const domainRoleSel = select<Role>(domainRole === "viewer" ? "viewer" : "editor", [["editor", "Can edit"], ["viewer", "Can view"]], "Role for the domain");
    const domainForm = h("form", { class: "invite-row" }, domain, domainRoleSel, h("button", { type: "submit", class: "btn" }, "Save"));
    domainForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      let v = domain.value.trim().toLowerCase();
      if (v && !v.includes("@")) v = `*@${v}`;
      if (v && !/^\*@[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return showError("Enter a domain like *@company.com.");
      try {
        details = await api.updateWorkspace(ws.id, { domainRule: v ? `${v}=${domainRoleSel.value}` : null });
        error.hidden = true;
        render();
        toast(v ? `Anyone with a ${v.slice(2)} email can open it.` : "Domain rule removed.");
      } catch (err) {
        showError(err);
      }
    });

    const copy = copyButton(link, "Copy link");
    clear(body,
      invite,
      // Invites become memberships when that verified Google email signs in, which needs Google sign-in here.
      opts.google ? null : h("p", { class: "hint invite-note" }, "People you invite can accept once Google sign-in is turned on for this server. They'll be asked to sign in with Google using that email."),
      error,
      h("section", { class: "share-section" },
        h("h3", { class: "label" }, "People"),
        rows.length ? h("ul", { class: "members" }, rows) : h("p", { class: "muted" }, "Nobody added yet."),
      ),
      h("section", { class: "share-section" },
        h("h3", { class: "label" }, "General access"),
        h("div", { class: "access-row" }, access),
        h("p", { class: "hint" }, d.linkAccess === "none" ? "Only the people above can open it." : "People who aren't signed in get a guest name."),
      ),
      h("section", { class: "share-section" },
        h("h3", { class: "label" }, "Everyone at a company"),
        domainForm,
        h("p", { class: "hint" }, "Anyone signed in with an email at this domain gets access."),
      ),
      h("div", { class: "modal-actions share-actions" },
        h("span", { class: "share-link", title: link }, link),
        copy,
      ),
    );
  };
  void load();
}

/** "Share note": a link to just this note, view or edit, copied as it's made. */
export function shareNoteDialog(repo: { id: string; title: string; writable: boolean }, path: string) {
  const roleSel = select<"viewer" | "editor">("viewer", repo.writable ? [["viewer", "Can view"], ["editor", "Can edit"]] : [["viewer", "Can view"]], "Access");
  const out = h("div", { class: "note-link-out" });
  const create = h("button", { type: "submit", class: "btn btn-primary" }, "Create link");
  const form = h("form", { class: "modal-body" },
    h("p", null, "Anyone with the link sees just this note, not the rest of ", h("b", null, repo.title), "."),
    h("label", { class: "field" }, h("span", null, "People with the link"), roleSel),
    out,
    h("div", { class: "modal-actions" },
      h("button", { type: "button", class: "btn", onclick: () => dlg.close() }, "Done"),
      create,
    ),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    create.disabled = true;
    try {
      const { url } = await api.createNoteLink(repo.id, path, roleSel.value as "viewer" | "editor");
      const ok = await copyText(url);
      clear(out, h("div", { class: "copy-block" }, h("pre", { class: "note-link-url" }, url), copyButton(url, "Copy")));
      toast(ok ? "Link copied." : "Link created. Copy it from the box.");
    } catch (err) {
      clear(out, h("p", { class: "form-error" }, errorMessage(err)));
    } finally {
      create.disabled = false;
    }
  });
  const dlg = modal("Share note", form);
  roleSel.focus();
}

/** Settings: the apps connected to this account (app tokens), with revoke. */
export function settingsDialog() {
  const list = h("div", { class: "tokens" }, h("p", { class: "muted" }, "Loading…"));
  const body = h("div", { class: "modal-body" },
    h("section", { class: "share-section" },
      h("h3", { class: "label" }, "Connected apps"),
      h("p", { class: "hint" }, "Apps you allowed to open your folders on this server, like Grimoire for Mac."),
      list,
    ),
  );
  modal("Settings", body, { wide: true });
  const load = async () => {
    let tokens: AppToken[];
    try {
      tokens = await api.tokens();
    } catch (err) {
      clear(list, h("p", { class: "form-error" }, err instanceof ApiError && err.status === 404 ? "This server doesn't support connected apps yet." : errorMessage(err)));
      return;
    }
    if (!tokens.length) return clear(list, h("p", { class: "muted" }, "No connected apps."));
    clear(list, h("ul", { class: "token-list" }, tokens.map((t) =>
      h("li", { class: "token", "data-id": t.id },
        h("span", { class: "token-who" },
          h("span", { class: "token-label" }, t.label || "App"),
          h("span", { class: "token-meta" }, `Connected ${relativeTime(t.createdAt)}`, t.lastUsedAt ? ` · last used ${relativeTime(t.lastUsedAt)}` : " · never used"),
        ),
        h("button", { type: "button", class: "btn btn-small", onclick: async () => {
          try {
            await api.revokeToken(t.id);
            toast(`Disconnected ${t.label || "the app"}.`);
            await load();
          } catch (err) {
            toast(errorMessage(err), "error");
          }
        } }, "Revoke"),
      ),
    )));
  };
  void load();
}
