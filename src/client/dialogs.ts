// Modal dialogs: prompt, confirm, add a GitHub repo; the agent prompt and copying text.
import { api, type ServerInfo, type TokenRow, type Workspace } from "./api.ts";
import { parseGitHubRepo } from "../shared/github.ts";
import { clear, errorMessage, h, pickNote, toast } from "./util.ts";

/** `backdrop: false`: a click outside doesn't close it (only its own buttons and Escape do). */
export function modal(title: string, body: HTMLElement, opts: { wide?: boolean; backdrop?: boolean; className?: string } = {}) {
  const dlg = h("dialog", { class: `modal${opts.wide ? " modal-wide" : ""}${opts.className ? ` ${opts.className}` : ""}` },
    h("div", { class: "modal-head" },
      h("h2", null, title),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Close", onclick: () => dlg.close() }, "×"),
    ),
    body,
  );
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg && opts.backdrop !== false) dlg.close();
  });
  document.body.appendChild(dlg);
  dlg.showModal();
  return dlg;
}

export function promptDialog(opts: { title: string; label: string; value?: string; submit?: string; hint?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const input = h("input", { type: "text", value: opts.value ?? "", required: true, autocomplete: "off", spellcheck: "false" });
    const form = h("form", { class: "modal-body", method: "dialog" },
      h("label", { class: "field" }, h("span", null, opts.label), input),
      opts.hint ? h("p", { class: "hint" }, opts.hint) : null,
      h("div", { class: "modal-actions" },
        h("button", { type: "button", class: "btn", onclick: () => dlg.close() }, "Cancel"),
        h("button", { type: "submit", class: "btn btn-primary" }, opts.submit ?? "OK"),
      ),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      result = v;
      dlg.close();
    });
    const dlg = modal(opts.title, form);
    dlg.addEventListener("close", () => resolve(result));
    input.focus();
    // Select the name part, not the extension.
    const dot = input.value.lastIndexOf(".");
    const slash = input.value.lastIndexOf("/");
    input.setSelectionRange(slash + 1, dot > slash ? dot : input.value.length);
  });
}

export function confirmDialog(opts: { title: string; message: string; confirm?: string; cancel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    const confirmBtn = h("button", { type: "button", class: `btn ${opts.danger ? "btn-danger" : "btn-primary"}`, onclick: () => ((ok = true), dlg.close()) }, opts.confirm ?? "OK");
    const body = h("div", { class: "modal-body" },
      h("p", null, opts.message),
      h("div", { class: "modal-actions" },
        h("button", { type: "button", class: "btn", onclick: () => dlg.close() }, opts.cancel ?? "Cancel"),
        confirmBtn,
      ),
    );
    const dlg = modal(opts.title, body);
    dlg.addEventListener("close", () => resolve(ok));
    confirmBtn.focus();
  });
}

/** Once, after a first sign-in made the account's own workspace (`title`); the Mac app's says the same. */
export function welcomeDialog(title: string): Promise<void> {
  return new Promise((resolve) => {
    const ok = h("button", { type: "button", class: "btn btn-primary", onclick: () => dlg.close() }, "Got it");
    const body = h("div", { class: "modal-body" },
      h("p", null, `Your notes live in “${title}”.`),
      h("p", null, h("strong", null, "Your notes are public. Anyone with the link to a workspace can see and edit its notes, even without signing in.")),
      h("p", null, "Grim is in beta, and private notes aren’t available yet."),
      h("p", null, "If you need privacy, you can self-host Grim: ",
        h("a", { href: "https://github.com/anomalyco/grim", target: "_blank", rel: "noopener noreferrer" }, "github.com/anomalyco/grim"), "."),
      h("div", { class: "modal-actions" }, ok),
    );
    const dlg = modal("Welcome to Grim", body, { backdrop: false });
    dlg.addEventListener("close", () => resolve());
    ok.focus();
  });
}

/** How long "Delete account" stays disabled after the dialog opens, so a double click can't delete by accident. */
export const DELETE_ACCOUNT_DELAY_MS = 1000;

/**
 * "Delete your account?": what goes (the account, its sign-ins and the workspaces it made), the email,
 * Cancel (focused) and a red Delete account, clickable after a second. `remove` deletes it; resolves true once it's
 * gone. An error shows in the dialog and leaves it open.
 */
export function deleteAccountDialog(email: string, remove: () => Promise<void>): Promise<boolean> {
  return new Promise((resolve) => {
    let deleted = false;
    let busy = false;
    const error = h("p", { class: "form-error", hidden: true });
    const confirmBtn = h("button", { type: "button", class: "btn btn-danger btn-red", disabled: true }, "Delete account") as HTMLButtonElement;
    const cancelBtn = h("button", { type: "button", class: "btn", onclick: () => dlg.close() }, "Cancel") as HTMLButtonElement;
    const body = h("div", { class: "modal-body delete-account" },
      email ? h("p", null, "Signed in as ", h("strong", null, email), ".") : null,
      h("p", null, "This permanently deletes:"),
      h("ul", { class: "delete-list" },
        h("li", null, "Your account and all its sign-ins, including Grim for Mac and connected MCP apps"),
        h("li", null, "The workspaces you created, with their notes and history"),
      ),
      h("p", null, "Workspaces other people created aren't affected. This can't be undone."),
      error,
      h("div", { class: "modal-actions" }, cancelBtn, confirmBtn),
    );
    confirmBtn.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      confirmBtn.disabled = cancelBtn.disabled = true;
      confirmBtn.textContent = "Deleting…";
      error.hidden = true;
      try {
        await remove();
        deleted = true;
        dlg.close();
      } catch (err) {
        busy = false;
        confirmBtn.disabled = cancelBtn.disabled = false;
        confirmBtn.textContent = "Delete account";
        error.textContent = errorMessage(err);
        error.hidden = false;
      }
    });
    const dlg = modal("Delete your account?", body, { backdrop: false, className: "modal-delete-account" });
    // (while it's being deleted, Escape doesn't close it)
    dlg.addEventListener("cancel", (e) => busy && e.preventDefault());
    dlg.addEventListener("close", () => resolve(deleted));
    setTimeout(() => (confirmBtn.disabled = busy), DELETE_ACCOUNT_DELAY_MS);
    cancelBtn.focus();
  });
}

export interface AddGitHubHooks {
  /** The repo was added (or already existed): show it in the sidebar. */
  added(repo: Workspace): void;
  /** The repo is ready to browse; `path` is the note to open, if any. `inDialog`: the dialog was still open. */
  ready(repo: Workspace, path: string | null, inDialog: boolean): void;
}

/** The dialog a form lives in (the Open dialog): close it, and whether it is still open. */
export interface DialogHost {
  close(): void;
  isOpen(): boolean;
}

/** Add a GitHub repo by URL or owner/name, wait for its import, then hand back the note to open. */
export function gitHubForm(server: ServerInfo, hooks: AddGitHubHooks, host: DialogHost) {
  const input = h("input", { type: "text", placeholder: "https://github.com/owner/name", required: true, autocomplete: "off", spellcheck: "false" });
  const readOnlyRadio = h("input", { type: "radio", name: "gh-mode", value: "read", checked: true });
  const editRadio = h("input", { type: "radio", name: "gh-mode", value: "edit" });
  const installHint = server.githubAppSlug
    ? h("p", { class: "hint", hidden: true }, "Editing syncs both ways and needs the ",
        h("a", { href: `https://github.com/apps/${server.githubAppSlug}/installations/new`, target: "_blank", rel: "noopener" }, "Grim GitHub App"),
        " installed on the repo.")
    : null;
  const status = h("p", { class: "hint gh-status", hidden: true });
  const error = h("p", { class: "form-error", hidden: true });
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, "Add");
  const form = h("form", { class: "modal-body" },
    h("label", { class: "field" }, h("span", null, "GitHub URL or owner/name"), input),
    server.githubAppSlug
      ? h("div", { class: "radio-group", role: "radiogroup", "aria-label": "Access" },
          h("label", { class: "check" }, readOnlyRadio, h("span", null, "Read-only")),
          h("label", { class: "check" }, editRadio, h("span", null, "Edit (needs the GitHub App installed)")),
        )
      : null,
    installHint,
    h("p", { class: "hint" }, "Shows the repo's Markdown files and keeps them up to date with GitHub. Read-only works for any public repo."),
    status,
    error,
    h("div", { class: "modal-actions" },
      h("button", { type: "button", class: "btn", onclick: () => host.close() }, "Cancel"),
      submit,
    ),
  );
  for (const r of [readOnlyRadio, editRadio]) r.addEventListener("change", () => installHint && (installHint.hidden = !editRadio.checked));

  let busy = false;
  const showError = (msg: string) => {
    status.hidden = true;
    if (host.isOpen()) {
      error.textContent = msg;
      error.hidden = false;
    } else toast(msg, "error");
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const raw = input.value.trim();
    const ref = parseGitHubRepo(raw);
    if (!ref) return showError("Enter a GitHub URL (https://github.com/owner/name) or owner/name.");
    busy = true;
    submit.disabled = true;
    error.hidden = true;
    status.hidden = false;
    status.textContent = `Looking up ${ref.owner}/${ref.name}…`;
    try {
      let repo = await api.addGitHub(raw, !editRadio.checked);
      hooks.added(repo);
      while (repo.status === "importing") {
        status.textContent = `Copying ${repo.title} from GitHub…`;
        await new Promise((r) => setTimeout(r, 1000));
        repo = await api.repo(repo.id);
      }
      if (repo.status === "error") {
        // A failed copy is useless in the sidebar; take it out again if we may (adding again retries).
        if (repo.canRemove) await api.deleteRepo(repo.id).catch(() => {});
        return showError(repo.error ?? "Import failed.");
      }
      const files = (await api.tree(repo.id)).files;
      if (!files.length) return showError(`No Markdown files in ${repo.title}.`);
      // The file from a /blob/ URL, or the folder from a /tree/ URL.
      const rest = ref.rest.join("/");
      const sub = ref.kind && rest.startsWith(`${repo.branch}/`) ? rest.slice(repo.branch.length + 1) : "";
      const path = pickNote(files, ref.kind === "blob" ? { file: sub } : { folder: sub });
      const inDialog = host.isOpen();
      host.close();
      hooks.ready(repo, path, inDialog);
    } catch (err) {
      showError(errorMessage(err));
    } finally {
      busy = false;
      submit.disabled = false;
    }
  });
  return { form, focus: () => input.focus() };
}


/**
 * The ready-to-paste instructions for an agent, with the workspace's URL (the native app's, word for word). `token`: an
 * app token of mine (full access, as me); null: a guest's prompt (edits existing notes only) unless `noSignIn`.
 */
export function agentPrompt(url: string, token: string | null, noSignIn: boolean, agentsMd = false) {
  const auth = token
    ? `Send this header on every request: Authorization: Bearer ${token}\n`
    : noSignIn
      ? ""
      : "Without a token you can only edit existing notes: not create, rename or delete them.\n";
  return `Work in this Grim workspace: ${url}\nUse plain HTTP (e.g. curl). GET that URL for instructions, then POST shell commands to it to read and edit its Markdown notes.\n${auth}Also send X-Agent-Session-Id: <your session id> and X-Agent-Session-Name: <your session title> if you have them.${agentsMd ? "\nThis workspace has an AGENTS.md; follow it." : ""}`;
}

/** A button that copies `text()` and says "Copied" for a moment; a promise (a token being made) says "Copying…" meanwhile. */
function copyButton(label: string, text: () => string | null | Promise<string | null>, cls = "btn"): HTMLButtonElement {
  const b: HTMLButtonElement = h("button", { type: "button", class: cls, onclick: () => void go() }, label);
  let timer = 0;
  async function go() {
    if (b.disabled) return;
    const t = text();
    let ok: boolean;
    if (typeof t === "string" || t === null) {
      if (!t) return;
      ok = await copyText(t);
    } else {
      b.disabled = true;
      b.textContent = "Copying…";
      try {
        ok = await copyLater(t);
      } catch (err) {
        b.textContent = label;
        return toast(errorMessage(err), "error");
      } finally {
        b.disabled = false;
      }
    }
    if (!ok) {
      b.textContent = label;
      return toast("Couldn't copy to the clipboard. Try again.", "error");
    }
    b.textContent = "Copied";
    clearTimeout(timer);
    timer = window.setTimeout(() => (b.textContent = label), 1500);
  }
  return b;
}

/**
 * Copy text that's still on its way. Safari only copies within the click, so the clipboard gets a ClipboardItem with
 * the promise at once; elsewhere (or if that fails) it waits and copies. A failed `text` throws.
 */
async function copyLater(text: Promise<string | null>): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    const blob = text.then((t) => new Blob([t ?? ""], { type: "text/plain" }));
    blob.catch(() => {});
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return true;
    } catch {
      // fall through (a failed `text` throws below)
    }
  }
  const t = await text;
  return !!t && copyText(t);
}

/**
 * "Share with an agent" (the sidebar card's Share): "This workspace" with only Copy prompt. Signed in, the prompt carries
 * an app token of mine (`token()`: made on the first copy, kept for the session), so the agent can do everything I can.
 * The native app's dialog matches it.
 */
export function shareDialog(opts: { url: string; noSignIn: boolean; token: (() => Promise<string>) | null; agentsMd?: boolean }) {
  const promptBtn = copyButton("Copy prompt", () =>
    opts.token ? opts.token().then((t) => agentPrompt(opts.url, t, opts.noSignIn, opts.agentsMd)) : agentPrompt(opts.url, null, opts.noSignIn, opts.agentsMd),
  );
  const hint = opts.token
    ? "Give this prompt to an agent (Claude, Codex, opencode…) to work in this workspace over plain HTTP. The prompt contains a token that acts as you. Revoke it under Account."
    : opts.noSignIn
      ? "Give this prompt to an agent (Claude, Codex, opencode…) to work in this workspace over plain HTTP."
      : "Give this prompt to an agent (Claude, Codex, opencode…) to work in this workspace over plain HTTP. Signed out, it can only edit existing notes.";
  const body = h("div", { class: "modal-body share-body" },
    h("section", { class: "share-sec", "aria-labelledby": "share-ws" },
      h("h3", { id: "share-ws" }, "This workspace"),
      h("p", { class: "hint" }, hint),
      h("div", { class: "share-btns" }, promptBtn),
    ),
    h("div", { class: "modal-actions" }, h("button", { type: "button", class: "btn btn-primary", onclick: () => dlg.close() }, "Done")),
  );
  const dlg = modal("Share with an agent", body, { className: "share-modal" });
  promptBtn.focus();
  return dlg;
}

/**
 * Account → "Tokens…": my active tokens (agent prompts', the Mac app's, MCP clients'), each with Revoke.
 */
export function tokensDialog(load: () => Promise<TokenRow[]>, revoke: (id: string) => Promise<void>) {
  const list = h("ul", { class: "token-list" }, h("li", { class: "hint" }, "Loading…"));
  const body = h("div", { class: "modal-body share-body" },
    h("p", { class: "hint" }, "Tokens act as you: whoever has one can do anything you can. Revoke any you no longer use."),
    list,
    h("div", { class: "modal-actions" }, h("button", { type: "button", class: "btn btn-primary", onclick: () => dlg.close() }, "Done")),
  );
  const dlg = modal("Tokens", body, { className: "share-modal tokens-modal" });
  const day = (t: number) => new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const render = (rows: TokenRow[]) => {
    if (!rows.length) return clear(list, h("li", { class: "hint" }, "No tokens."));
    clear(list, ...rows.map((r) => {
      const btn: HTMLButtonElement = h("button", { type: "button", class: "btn btn-small", onclick: async () => {
        btn.disabled = true;
        try {
          await revoke(r.id);
          li.remove();
          if (!list.children.length) render([]);
        } catch (err) {
          btn.disabled = false;
          toast(errorMessage(err), "error");
        }
      } }, "Revoke");
      const when = `Made ${day(r.createdAt)}${r.lastUsedAt ? ` · last used ${day(r.lastUsedAt)}` : " · never used"}${r.mcp ? " · MCP" : ""}`;
      const li = h("li", { class: "token-row" }, h("div", { class: "token-text" }, h("div", { class: "token-label" }, r.label), h("div", { class: "hint" }, when)), btn);
      return li;
    }));
  };
  load().then(render, (err) => clear(list, h("li", { class: "hint" }, errorMessage(err))));
  return dlg;
}

/**
 * Copy text to the clipboard. The async Clipboard API only exists on secure origins (https, localhost), so on plain
 * http (e.g. a Tailscale address) fall back to a hidden textarea and execCommand("copy"), which works on a click.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
  // Inside a modal <dialog>, only elements within it can take focus.
  (document.querySelector("dialog[open]") ?? document.body).appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}
