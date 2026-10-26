// Modal dialogs: prompt, confirm, add a GitHub repo, share a notebook with an agent.
import { api, type Config, type Repo } from "./api.ts";
import { parseGitHubRepo } from "../shared/github.ts";
import { clear, errorMessage, h, pickNote, relativeTime, toast } from "./util.ts";

function modal(title: string, body: HTMLElement, opts: { wide?: boolean } = {}) {
  const dlg = h("dialog", { class: `modal${opts.wide ? " modal-wide" : ""}` },
    h("div", { class: "modal-head" },
      h("h2", null, title),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Close", onclick: () => dlg.close() }, "×"),
    ),
    body,
  );
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close();
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

export function confirmDialog(opts: { title: string; message: string; confirm?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    const confirmBtn = h("button", { type: "button", class: `btn ${opts.danger ? "btn-danger" : "btn-primary"}`, onclick: () => ((ok = true), dlg.close()) }, opts.confirm ?? "OK");
    const body = h("div", { class: "modal-body" },
      h("p", null, opts.message),
      h("div", { class: "modal-actions" },
        h("button", { type: "button", class: "btn", onclick: () => dlg.close() }, "Cancel"),
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

/** Add a GitHub repo by URL or owner/name, wait for its import, then hand back the note to open. */
export function addGitHubDialog(config: Config, hooks: AddGitHubHooks) {
  const input = h("input", { type: "text", placeholder: "https://github.com/owner/name", required: true, autocomplete: "off", spellcheck: "false" });
  const readOnlyRadio = h("input", { type: "radio", name: "gh-mode", value: "read", checked: true });
  const editRadio = h("input", { type: "radio", name: "gh-mode", value: "edit" });
  const installHint = config.githubAppSlug
    ? h("p", { class: "hint", hidden: true }, "Editing syncs both ways and needs the ",
        h("a", { href: `https://github.com/apps/${config.githubAppSlug}/installations/new`, target: "_blank", rel: "noopener" }, "Grimoire GitHub App"),
        " installed on the repo.")
    : null;
  const status = h("p", { class: "hint gh-status", hidden: true });
  const error = h("p", { class: "form-error", hidden: true });
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, "Add repo");
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
      h("button", { type: "button", class: "btn", onclick: () => dlg.close() }, "Cancel"),
      submit,
    ),
  );
  for (const r of [readOnlyRadio, editRadio]) r.addEventListener("change", () => installHint && (installHint.hidden = !editRadio.checked));

  let open = true;
  let busy = false;
  const showError = (msg: string) => {
    status.hidden = true;
    if (open) {
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
      const inDialog = open;
      dlg.close();
      hooks.ready(repo, path, inDialog);
    } catch (err) {
      showError(errorMessage(err));
    } finally {
      busy = false;
      submit.disabled = false;
    }
  });
  const dlg = modal("Add a GitHub repo", form);
  dlg.addEventListener("close", () => (open = false));
  input.focus();
}


/** "Share with agent": the notebook's link (created on first use) and a prompt ready to paste to an agent. */
export function shareDialog(repo: Repo) {
  const body = h("div", { class: "modal-body" }, h("p", { class: "muted" }, "Preparing a link…"));
  modal("Share with agent", body, { wide: true });
  void (async () => {
    try {
      const { url } = await api.myShare(repo.id);
      const prompt = `Use this Grimoire notebook as your workspace: ${url}\nFetch that URL first (HTTP GET) for instructions; it is a folder of Markdown files you work on by POSTing shell commands to the same URL.`;
      const copy = copyButton(prompt, "Copy");
      copy.classList.add("btn-primary");
      clear(body,
        h("p", { class: "hint" }, `Paste this to your agent. It can ${repo.readOnly ? "read" : "read and edit"} “${repo.title}” as a folder of Markdown files.`),
        h("div", { class: "copy-block" }, h("pre", null, prompt), copy),
      );
      copy.focus();
    } catch (err) {
      clear(body, h("p", { class: "form-error" }, errorMessage(err)));
    }
  })();
}

function copyButton(text: string, label: string) {
  const btn = h("button", { type: "button", class: "btn btn-small", onclick: async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Copy failed";
    }
    setTimeout(() => (btn.textContent = label), 1500);
  } }, label);
  return btn;
}

function copyBlock(text: string, label = "Copy") {
  return h("div", { class: "copy-block" }, h("pre", null, text), copyButton(text, label));
}
