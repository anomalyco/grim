// Modal dialogs: prompt, confirm; the agent prompt and copying text.
import { api, type ServerInfo, type Workspace } from "./api.ts";
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

/** The dialog a form lives in (the Open dialog): close it, and whether it is still open. */
export interface DialogHost {
  close(): void;
  isOpen(): boolean;
}

/** The ready-to-paste instructions for an agent, with the workspace's URL (the native app's, word for word). */
export function agentPrompt(url: string, noSignIn: boolean) {
  const guest = noSignIn ? "" : " Without a token you can edit existing notes but not create new ones; for that, use Grim's MCP server.";
  return `Work in this Grim workspace: ${url}\nGET that URL (plain HTTP, e.g. curl) for its notes and instructions. Each note has its own URL: POST a shell command to a note's URL to run it with that note as the only file (cat, sed -i, grep, >>; history for its versions).${guest}`;
}

/** The MCP section's prompt: add the server's `/mcp` to the agent's MCP configuration (the native app's, word for word). */
export function mcpPrompt(mcpUrl: string, noSignIn: boolean) {
  const auth = noSignIn ? "no sign-in needed on this server" : "it signs in with OAuth in the browser the first time";
  return `Add the Grim MCP server to your MCP configuration: URL ${mcpUrl} (Streamable HTTP; ${auth}). Then use its list_workspaces, list_notes and note_command tools to work on my Grim notes, one note per command.`;
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
 * "Share with an agent" (the sidebar card's Share): this workspace's URL (the agents' address too: GET for
 * instructions, POST commands) and its prompt, then the account's MCP server (`$PUBLIC_URL/mcp`) with its prompt, URL
 * and opencode's config. The native app's dialog matches it.
 */
export function shareDialog(opts: { url: string; noSignIn: boolean }) {
  const mcpUrl = new URL("/mcp", opts.url).href;
  const linkField = codeField(opts.url);
  const promptBtn = copyButton("Copy prompt", () => agentPrompt(opts.url, opts.noSignIn));

  const mcpField = codeField(mcpUrl);
  const snippets = mcpSnippets(mcpUrl, opts.noSignIn).map((s) => ({ ...s, field: codeField(s.code, true) }));
  const sec = (key: string, title: string, ...kids: HTMLElement[]) =>
    h("section", { class: "share-sec", "aria-labelledby": `share-${key}` }, h("h3", { id: `share-${key}` }, title), ...kids);
  const body = h("div", { class: "modal-body share-body" },
    sec("ws", "This workspace",
      h("p", { class: "hint" },
        opts.noSignIn
          ? "Give this prompt to an agent. It works with this workspace over plain HTTP (no setup): it GETs the URL for the notes and instructions, then POSTs commands to a note's URL, one note at a time."
          : "Give this prompt to an agent. It works with this workspace over plain HTTP (no setup), one note at a time: GET the URL for the notes, POST commands to a note's URL. Without a token it can read and edit existing notes; to create notes, use MCP (below)."),
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
