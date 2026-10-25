// Modal dialogs: prompt, confirm, link GitHub repo, agent tokens.
import { api, type Config } from "./api.ts";
import { clear, errorMessage, h, relativeTime, toast } from "./util.ts";

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

export function linkGitHubDialog(config: Config): Promise<string | null> {
  return new Promise((resolve) => {
    let created: string | null = null;
    const input = h("input", { type: "text", placeholder: "owner/name", required: true, autocomplete: "off", spellcheck: "false" });
    const ro = h("input", { type: "checkbox" });
    const error = h("p", { class: "form-error", hidden: true });
    const submit = h("button", { type: "submit", class: "btn btn-primary" }, "Link repo");
    const form = h("form", { class: "modal-body" },
      h("label", { class: "field" }, h("span", null, "GitHub repository"), input),
      h("label", { class: "check" }, ro, h("span", null, "Public repo, read-only copy (no GitHub App needed)")),
      config.githubAppSlug
        ? h("p", { class: "hint" }, "To edit and sync a repo, first ",
            h("a", { href: `https://github.com/apps/${config.githubAppSlug}/installations/new`, target: "_blank", rel: "noopener" }, "install the GitHub App"),
            " on it.")
        : null,
      error,
      h("div", { class: "modal-actions" },
        h("button", { type: "button", class: "btn", onclick: () => dlg.close() }, "Cancel"),
        submit,
      ),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = normalizeGitHubRepo(input.value);
      if (!name) {
        error.textContent = "Enter a repository as owner/name or a github.com URL.";
        error.hidden = false;
        return;
      }
      submit.disabled = true;
      error.hidden = true;
      try {
        const repo = await api.linkGitHub(name, ro.checked);
        created = repo.id;
        dlg.close();
      } catch (err) {
        error.textContent = errorMessage(err);
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    });
    const dlg = modal("Link GitHub repo", form);
    dlg.addEventListener("close", () => resolve(created));
    input.focus();
  });
}

export function agentTokensDialog() {
  const list = h("div", null, h("p", { class: "muted" }, "Loading…"));
  const reveal = h("div", { class: "token-reveal", hidden: true });
  const nameInput = h("input", { type: "text", placeholder: "Agent name, e.g. Claude", required: true, autocomplete: "off" });
  const error = h("p", { class: "form-error", hidden: true });
  const createBtn = h("button", { type: "submit", class: "btn btn-primary" }, "Create token");
  const form = h("form", { class: "token-create" }, nameInput, createBtn);

  const load = async () => {
    try {
      const tokens = await api.agentTokens();
      if (!tokens.length) {
        clear(list, h("p", { class: "muted" }, "No agent tokens yet."));
        return;
      }
      clear(list, h("table", { class: "tokens" },
        h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, "Created"), h("th", null, "Last used"), h("th", null))),
        h("tbody", null, tokens.map((t) =>
          h("tr", null,
            h("td", null, t.name),
            h("td", null, relativeTime(t.createdAt)),
            h("td", null, t.lastUsedAt ? relativeTime(t.lastUsedAt) : "never"),
            h("td", null, h("button", { class: "btn btn-small btn-danger-ghost", type: "button", onclick: async () => {
              const ok = await confirmDialog({ title: "Delete token", message: `Delete “${t.name}”? Agents using it will lose access.`, confirm: "Delete", danger: true });
              if (!ok) return;
              try {
                await api.deleteAgentToken(t.id);
              } catch (err) {
                toast(errorMessage(err), "error");
              }
              void load();
            } }, "Delete")),
          ))),
      ));
    } catch (err) {
      clear(list, h("p", { class: "form-error" }, errorMessage(err)));
    }
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name || createBtn.disabled) return;
    error.hidden = true;
    createBtn.disabled = true;
    try {
      const { token } = await api.createAgentToken(name);
      nameInput.value = "";
      const snippet = JSON.stringify({ mcpServers: { grimoire: { type: "http", url: `${location.origin}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
      clear(reveal,
        h("p", null, h("strong", null, "Copy this token now."), " It won't be shown again."),
        copyBlock(token),
        h("p", { class: "hint" }, "MCP config:"),
        copyBlock(snippet),
      );
      reveal.hidden = false;
      void load();
    } catch (err) {
      error.textContent = errorMessage(err);
      error.hidden = false;
    } finally {
      createBtn.disabled = false;
    }
  });

  modal("Agent tokens", h("div", { class: "modal-body" },
    h("p", { class: "hint" }, "Agents connect over MCP at ", h("code", null, `${location.origin}/mcp`), " with a bearer token."),
    form, error, reveal, list,
  ), { wide: true });
  nameInput.focus();
  void load();
}

function copyBlock(text: string) {
  const btn = h("button", { type: "button", class: "btn btn-small", onclick: async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Copy failed";
    }
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  } }, "Copy");
  return h("div", { class: "copy-block" }, h("pre", null, text), btn);
}

/** "owner/name" from "owner/name", "github.com/owner/name", "https://github.com/owner/name(.git)(/tree/…)", or null. */
export function normalizeGitHubRepo(input: string): string | null {
  let s = input.trim().replace(/^git@github\.com:/i, "").replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "");
  s = s.split(/[?#]/)[0]!;
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  const name = parts[1]!.replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === "." || name === "..") return null;
  return `${owner}/${name}`;
}
