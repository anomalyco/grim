// Modal dialogs: prompt, confirm, add a GitHub repo; the agent prompt and copying text.
import { api, type Config, type Repo } from "./api.ts";
import { parseGitHubRepo } from "../shared/github.ts";
import { errorMessage, h, pickNote, toast } from "./util.ts";

/** `backdrop: false`: a click outside doesn't close it (only its own buttons and Escape do). */
export function modal(title: string, body: HTMLElement, opts: { wide?: boolean; backdrop?: boolean } = {}) {
  const dlg = h("dialog", { class: `modal${opts.wide ? " modal-wide" : ""}` },
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

export interface AddGitHubHooks {
  /** The repo was added (or already existed): show it in the sidebar. */
  added(repo: Repo): void;
  /** The repo is ready to browse; `path` is the note to open, if any. `inDialog`: the dialog was still open. */
  ready(repo: Repo, path: string | null, inDialog: boolean): void;
}

/** The dialog a form lives in (the Open dialog): close it, and whether it is still open. */
export interface DialogHost {
  close(): void;
  isOpen(): boolean;
}

/** Add a GitHub repo by URL or owner/name, wait for its import, then hand back the note to open. */
export function gitHubForm(config: Config, hooks: AddGitHubHooks, host: DialogHost) {
  const input = h("input", { type: "text", placeholder: "https://github.com/owner/name", required: true, autocomplete: "off", spellcheck: "false" });
  const readOnlyRadio = h("input", { type: "radio", name: "gh-mode", value: "read", checked: true });
  const editRadio = h("input", { type: "radio", name: "gh-mode", value: "edit" });
  const installHint = config.githubAppSlug
    ? h("p", { class: "hint", hidden: true }, "Editing syncs both ways and needs the ",
        h("a", { href: `https://github.com/apps/${config.githubAppSlug}/installations/new`, target: "_blank", rel: "noopener" }, "Grim GitHub App"),
        " installed on the repo.")
    : null;
  const status = h("p", { class: "hint gh-status", hidden: true });
  const error = h("p", { class: "form-error", hidden: true });
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, "Add");
  const form = h("form", { class: "modal-body" },
    h("label", { class: "field" }, h("span", null, "GitHub URL or owner/name"), input),
    config.githubAppSlug
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


/** The ready-to-paste instructions for an agent, with the folder's agent link (`/a/<uuid>`). */
export function agentPrompt(url: string) {
  return `Work in this Grim notebook: ${url}\nFetch that URL first (HTTP GET) for instructions; it is a workspace of Markdown files you work on by POSTing shell commands to the same URL.`;
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
