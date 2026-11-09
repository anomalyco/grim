// Workspaces: remote workspace URLs, the remembered workspaces on other servers, and the Open and New dialogs.
import type { ServerInfo } from "./api.ts";
import { modal, type DialogHost } from "./dialogs.ts";
import { errorMessage, h, toast } from "./util.ts";

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

/** A bare folder name (its id in the URL, e.g. "notes" or "demo"): that folder on this server. */
function folderName(raw: string): WorkspaceRef | null {
  const s = raw.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s) ? { origin: location.origin, workspace: s, path: null } : null;
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

/** Forget every remembered workspace on other servers (signing out). */
export function forgetAllRemotes() {
  try {
    localStorage.removeItem(REMOTE_KEY);
  } catch {}
}

export function forgetRemote(ref: { origin: string; workspace: string }) {
  const list = rememberedRemotes("").filter((r) => !(r.origin === ref.origin && r.workspace === ref.workspace));
  try {
    localStorage.setItem(REMOTE_KEY, JSON.stringify(list));
  } catch {}
}

// ---------- dialogs ----------

export interface OpenHooks {
  /** A remote folder URL to open (this server or another). */
  openRemote(ref: WorkspaceRef): void;
}

/** "Open…": open a folder or note by URL (any server) or by workspace name. */
export function openDialog(hooks: OpenHooks) {
  let open = true;
  const only = remoteForm(hooks, { close: () => dlg.close(), isOpen: () => open });
  const dlg = modal("Open workspace", only.form, { className: "open-url-modal" });
  dlg.addEventListener("close", () => (open = false));
  only.focus();
}

function remoteForm(hooks: OpenHooks, host: DialogHost) {
  const input = h("input", { type: "text", placeholder: `https://${location.host}/app/…`, required: true, autocomplete: "off", spellcheck: "false", "aria-label": "URL or workspace name" });
  const error = h("p", { class: "form-error", hidden: true, role: "alert" });
  const form = h("form", { class: "modal-body" },
    h("label", { class: "field" }, h("span", null, "URL"), input),
    h("p", { class: "hint" }, "Paste the link to a workspace or a note on any Grim server, or type the name of a workspace on this one."),
    error,
    h("div", { class: "modal-actions" },
      h("button", { type: "button", class: "btn", onclick: () => host.close() }, "Cancel"),
      h("button", { type: "submit", class: "btn btn-primary" }, "Open"),
    ),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const ref = folderName(input.value) ?? parseWorkspaceUrl(input.value);
    if (!ref) {
      error.textContent = "That isn't a workspace name or a workspace or note link. A link looks like https://server/app/workspace or https://server/app/workspace/note.md.";
      error.hidden = false;
      return;
    }
    host.close();
    hooks.openRemote(ref);
  });
  return { form, focus: () => input.focus() };
}

/** "New…": create a folder on this server (`create` opens it). */
export function newDialog(hooks: { create(title: string): Promise<void> }) {
  const name = h("input", { type: "text", required: true, autocomplete: "off", spellcheck: "false", "aria-label": "Name" }) as HTMLInputElement;
  const error = h("p", { class: "form-error", hidden: true, role: "alert" });
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, "Create") as HTMLButtonElement;
  const form = h("form", { class: "modal-body new-folder" },
    h("label", { class: "field" }, h("span", null, "Name"), name),
    h("p", { class: "hint" }, `A workspace of Markdown notes on ${location.host}. Anyone with its link can open and edit it.`),
    error,
    h("div", { class: "modal-actions" },
      h("button", { type: "button", class: "btn", onclick: () => dlg.close() }, "Cancel"),
      submit,
    ),
  );
  let open = true;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = name.value.trim();
    if (!title || submit.disabled) return;
    submit.disabled = true;
    error.hidden = true;
    try {
      await hooks.create(title);
      dlg.close();
    } catch (err) {
      if (!open) return toast(errorMessage(err), "error");
      error.textContent = errorMessage(err);
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  const dlg = modal("New workspace", form);
  dlg.addEventListener("close", () => (open = false));
  name.focus();
  return dlg;
}
