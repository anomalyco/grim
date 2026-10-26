// Signed-out pages: the home page (a live example note you can type in) and /start (the getting-started guide).
// Both use the real editor on a local Y.Doc: nothing is synced or saved.
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { mountEditor } from "./editor/index.ts";
import type { Config } from "./api.ts";
import { clear, h } from "./util.ts";

const EXAMPLE = `# Grimoire
Type here: it's a **live** Markdown note. Try *italic*, ==highlight== or \`code\`.

- Plain Markdown files, stored in Git
- Everyone sees edits and cursors as they happen
- [x] Write a note
- [ ] Hand it to an agent

> Edits are committed as you go.`;

function guide(origin: string) {
  return `# Getting started
Grimoire is a shared notepad: Markdown notes that people and agents edit together, stored in Git.

## 1. Sign in
Sign in on the home page. Notes live in notebooks (each one is a Git repo); the first one is called **Notes**.

## 2. Create a note
Click **+ New note** in the sidebar and give it a path. Slashes make folders: \`projects/ideas.md\` goes in \`projects\`. Press \`/\` to filter your files.

## 3. Write together
Open the same note as someone else and you both see edits and cursors live. Markdown renders as you type: \`#\` headings, \`-\` lists, \`- [ ]\` todos, \`**bold**\`, \`==highlight==\`.

## 4. History and restore
Notes save themselves: each one is committed to Git a few seconds after you stop typing. Open **History** to see versions and diffs, and restore an older one.

## 5. Link a GitHub repo
Choose **Link GitHub repo…** in your menu to sync a repo's Markdown files both ways (install the GitHub App on it first), or add a public repo as a read-only copy.

## 6. Connect an agent
Open a notebook's **⋯** menu and choose **Share with agent…**, then **Create link**. Give the link to your agent, for example:
\`\`\`
Use this Grimoire notebook as your workspace: ${origin}/a/… — GET it first for instructions.
\`\`\`
The link is the agent's way in: a GET returns instructions, and each POST runs a shell command in the notebook, which is a folder of Markdown files. Its edits show up live, with its own cursor. Anyone with the link can use it, so revoke it in the same dialog when you're done.

From a terminal, use the \`grimoire\` CLI:
\`\`\`bash
export GRIMOIRE_SHARE_URL=${origin}/a/…
grimoire 'ls -R'
\`\`\`
Inside the shell, the usual tools work:
\`\`\`bash
cat Welcome.md
echo "- [ ] Review the draft" >> todo.md
grep -rn TODO .
save    # commit now instead of waiting 3 s
\`\`\``;
}

/** Mount the editor on a local document that never leaves the page. */
function localEditor(host: HTMLElement, text: string, readOnly: boolean) {
  const doc = new Y.Doc();
  doc.getText("md").insert(0, text);
  return mountEditor(host, { ytext: doc.getText("md"), awareness: new Awareness(doc), readOnly });
}

function slab() {
  return h("a", { class: "slab-blk", href: "/", "aria-label": "Grimoire home" }, "GRIMOIRE");
}

function signIn(config: Config) {
  const err = new URLSearchParams(location.search).get("error");
  return h("div", { class: "home-signin" },
    err ? h("p", { class: "form-error", role: "alert" }, err) : null,
    config.githubLogin ? h("a", { class: "btn btn-primary", href: "/auth/github" }, "Sign in with GitHub") : null,
    config.devLogin
      ? h("form", { class: "dev-login", method: "post", action: "/auth/dev" },
          h("input", { type: "text", name: "name", placeholder: "Your name", required: true, autocomplete: "name", "aria-label": "Your name (development sign-in)" }),
          h("button", { type: "submit", class: `btn${config.githubLogin ? "" : " btn-primary"}` }, "Continue"),
        )
      : null,
    !config.githubLogin && !config.devLogin ? h("p", { class: "form-error" }, "No sign-in method is configured on this server.") : null,
  );
}

export function renderHome(app: HTMLElement, config: Config) {
  app.className = "home";
  document.title = "Grimoire";
  const box = h("div", { class: "home-editor", "aria-label": "Example note, try typing" });
  clear(app, h("div", { class: "home-page" },
    h("header", { class: "home-top" }, slab()),
    h("main", { class: "home-main" },
      box,
      h("p", { class: "home-caption" }, "A scratch note: type in it. Nothing here is saved."),
      h("p", { class: "home-about" },
        "Grimoire is a notepad for people and agents. Notes are live, multiplayer Markdown, stored as plain files in Git. ",
        "Agents edit the same files through a shell, and you see their cursor as they write.",
      ),
      h("div", { class: "home-actions" },
        signIn(config),
        h("a", { class: "home-start", href: "/start" }, "Get started →"),
      ),
    ),
  ));
  localEditor(box, EXAMPLE, false);
}

export function renderStart(app: HTMLElement, config: Config, signedIn: boolean) {
  app.className = "home start";
  document.title = "Getting started · Grimoire";
  const doc = h("div", { class: "start-doc" });
  clear(app, h("div", { class: "home-page" },
    h("header", { class: "home-top" },
      slab(),
      h("nav", { class: "home-nav" },
        signedIn ? h("a", { class: "btn btn-primary", href: "/" }, "Open Grimoire") : h("a", { href: "/" }, "← Home"),
      ),
    ),
    h("main", { class: "start-main" },
      doc,
      h("div", { class: "home-actions start-end" },
        signedIn ? h("a", { class: "btn btn-primary", href: "/" }, "Open Grimoire") : signIn(config),
        signedIn ? null : h("a", { class: "home-start", href: "/" }, "← Back to home"),
      ),
    ),
  ));
  localEditor(doc, guide(location.origin), true);
}
