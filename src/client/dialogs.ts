// Modal dialogs: prompt, confirm, add a GitHub repo; the agent prompt and copying text.
import { api, type ServerInfo, type Workspace } from "./api.ts";
import { parseGitHubRepo } from "../shared/github.ts";
import { errorMessage, h, pickNote, toast } from "./util.ts";

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


/** The ready-to-paste instructions for an agent, with the folder's agent link (`/a/<uuid>`). */
export function agentPrompt(url: string) {
  return `Work in this Grim notebook: ${url}\nFetch that URL first (HTTP GET) for instructions; it is a workspace of Markdown files you work on by POSTing shell commands to the same URL.`;
}

/** The MCP section's prompt: add the server's `/mcp` to the agent's MCP configuration (the native app's, word for word). */
export function mcpPrompt(mcpUrl: string, noSignIn: boolean) {
  const auth = noSignIn ? "no sign-in needed on this server" : "it signs in with OAuth in the browser the first time";
  return `Add the Grim MCP server to your MCP configuration: URL ${mcpUrl} (Streamable HTTP; ${auth}). Then use its list_workspaces, command and changes tools to work in my Grim workspaces.`;
}

/** The "opencode config" disclosure: opencode's MCP config (docs/README.md, "Connect an MCP client"). */
export function mcpSnippets(mcpUrl: string, noSignIn: boolean): { name: string; where: string; code: string }[] {
  return [
    { name: "opencode", where: noSignIn ? "In opencode.json:" : "In opencode.json, then opencode mcp auth grim:", code: `{"mcp": {"grim": {"type": "remote", "url": "${mcpUrl}"}}}` },
  ];
}

/** A button that copies `text()` and says "Copied" for a moment (`small`: the one inside a code field). */
function copyButton(label: string, text: () => string | null, cls = "btn"): HTMLButtonElement {
  const b: HTMLButtonElement = h("button", { type: "button", class: cls, onclick: () => void go() }, label);
  let timer = 0;
  async function go() {
    const t = text();
    if (!t) return;
    if (!(await copyText(t))) return toast("Couldn't copy to the clipboard. Try again.", "error");
    b.textContent = "Copied";
    clearTimeout(timer);
    timer = window.setTimeout(() => (b.textContent = label), 1500);
  }
  return b;
}

/** A value in a monospace field with its own small Copy (`wrap`: long snippets wrap instead of scrolling). */
function codeField(value: string, wrap = false) {
  const code = h("code", { class: "share-code-text" }, value);
  const copy = copyButton("Copy", () => code.textContent || null, "share-code-copy");
  return { el: h("div", { class: `share-code${wrap ? " share-code-wrap" : ""}` }, code, copy), code, copy };
}

/**
 * "Share with an agent" (the sidebar card's Share): this workspace's agent link and its prompt, then the account's
 * MCP server (`$PUBLIC_URL/mcp`) with its prompt, URL and opencode's config. `link` is my agent link
 * for the workspace (made by the server; may still be coming). The native app's dialog matches it.
 */
export function shareDialog(opts: { link: string | Promise<string>; noSignIn: boolean }) {
  let link: string | null = typeof opts.link === "string" ? opts.link : null;
  const mcpOf = (base: string) => new URL("/mcp", base).href;
  let mcpUrl = mcpOf(link ?? location.origin);

  const linkField = codeField(link ?? "Making a link…");
  const promptBtn = copyButton("Copy prompt", () => (link ? agentPrompt(link) : null));
  if (!link) linkField.copy.disabled = promptBtn.disabled = true;

  const mcpField = codeField(mcpUrl);
  const snippets = mcpSnippets(mcpUrl, opts.noSignIn).map((s) => ({ ...s, field: codeField(s.code, true) }));
  const sec = (key: string, title: string, ...kids: HTMLElement[]) =>
    h("section", { class: "share-sec", "aria-labelledby": `share-${key}` }, h("h3", { id: `share-${key}` }, title), ...kids);
  const body = h("div", { class: "modal-body share-body" },
    sec("ws", "This workspace",
      h("p", { class: "hint" }, "Give this prompt to an agent. It works with this workspace directly over HTTP (no setup) and can only see this workspace."),
      linkField.el,
      h("div", { class: "share-btns" }, promptBtn),
    ),
    sec("mcp", "All your workspaces (MCP)",
      h("p", { class: "hint" },
        opts.noSignIn
          ? "Add Grim as an MCP server in your agent or tool (Claude, Cursor, opencode…). It can work with all the workspaces on this server; no sign-in needed on this server."
          : "Add Grim as an MCP server in your agent or tool (Claude, Cursor, opencode…). It can work with all your workspaces, and signs in with your Grim account the first time."),
      mcpField.el,
      h("div", { class: "share-btns" }, copyButton("Copy prompt", () => mcpPrompt(mcpUrl, opts.noSignIn))),
      h("details", { class: "share-snippets" },
        h("summary", null, "opencode config"),
        ...snippets.map((s) => h("div", { class: "share-snippet" }, h("div", { class: "share-snippet-head" }, s.where), s.field.el)),
      ),
    ),
    h("div", { class: "modal-actions" }, h("button", { type: "button", class: "btn btn-primary", onclick: () => dlg.close() }, "Done")),
  );
  const dlg = modal("Share with an agent", body, { className: "share-modal" });
  promptBtn.focus();
  if (typeof opts.link !== "string") {
    opts.link.then(
      (url) => {
        link = url;
        linkField.code.textContent = url;
        linkField.copy.disabled = promptBtn.disabled = false;
        // the server's public URL (the link's origin) rather than the address this page was opened at
        mcpUrl = mcpOf(url);
        mcpField.code.textContent = mcpUrl;
        mcpSnippets(mcpUrl, opts.noSignIn).forEach((s, i) => (snippets[i]!.field.code.textContent = s.code));
        // it couldn't take the focus while disabled
        if (dlg.open && (!dlg.contains(document.activeElement) || document.activeElement?.matches(".modal-head .icon-btn"))) promptBtn.focus();
      },
      (err) => {
        linkField.code.textContent = errorMessage(err);
        linkField.el.classList.add("share-code-error");
      },
    );
  }
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
