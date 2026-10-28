// Signed-out pages: the home page (a live example note you can type in) and /start (the getting-started guide).
// Both use the real editor on a local text: nothing is synced or saved.
import { mountEditor } from "./editor-rs/index.ts";
import type { Config, ServerInfo } from "./api.ts";
import { clear, h } from "./util.ts";
import { signInDialog } from "./signin.ts";

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

## 1. Open the notes
Click **View the notes** on the home page: you can look around right away, without an account. Notes live in folders (each one is a Git repo of Markdown files); the first one is called **Notes**. The folder menu at the top left of the sidebar switches between them. Every folder is public: anyone with its link can open it.

Not signed in, you show up to others under a made-up name (like *moist-noodle*) and get a few edits to try it out. **Sign in** (bottom left of the sidebar) to keep editing, create notes and folders, and hand a folder to an agent. Just want to play with the editor? Open a **scratch note** (\`/scratch\`): it stays in your browser.

## 2. Create a note
Signed in, click **+ New note** in the sidebar and give it a path. Slashes make subfolders: \`projects/ideas.md\` goes in \`projects\`. Press \`/\` to filter your files.

## 3. Write together
Open the same note as someone else and you both see edits and cursors live. Markdown renders as you type: \`#\` headings, \`-\` lists, \`- [ ]\` todos, \`**bold**\`, \`==highlight==\`.

## 4. History and restore
Notes save themselves: each one is committed to Git a few seconds after you stop typing. Open **History** to see versions and diffs, and restore an older one.

## 5. Link a GitHub repo
Open the folder menu, choose **Open…** and then **GitHub repo**, and paste a repo URL. Public repos are added as read-only copies that stay up to date with GitHub; editing a repo (synced both ways) needs the GitHub App installed on it.

## 6. Connect an agent
Signed in, at the bottom of the sidebar, **Share with an agent** has a **Copy** button: it copies a prompt with your link for the open notebook (the same link every time) to paste to your agent:
\`\`\`
Work in this Grimoire notebook: ${origin}/a/…
\`\`\`
The link is the agent's way in: a GET returns instructions, and each POST runs a shell command in the notebook, which is a folder of Markdown files. Its edits show up live, with its own cursor. Anyone with the link can edit that notebook, so only give it to agents you trust.

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
  return mountEditor(host, { text, readOnly });
}

function slab() {
  return h("a", { class: "slab-blk", href: "/", "aria-label": "Grimoire home" }, "GRIMOIRE");
}

/**
 * The call to action: "View the notes" (the app, without an account) and "Sign in" (the server's sign-in methods in
 * a dialog).
 */
function viewNotes(config: Config, server: ServerInfo) {
  const err = new URLSearchParams(location.search).get("error");
  return h("div", { class: "home-cta" },
    err ? h("p", { class: "form-error", role: "alert" }, err) : null,
    h("div", { class: "cta-row" },
      h("a", { class: "btn btn-primary btn-cta", href: "/app" }, "View the notes"),
      h("a", { class: "cta-signin", href: "/app", onclick: (e: MouseEvent) => {
        e.preventDefault();
        signInDialog(config, server);
      } }, "Sign in"),
    ),
  );
}

function openApp() {
  return h("div", { class: "home-cta" }, h("a", { class: "btn btn-primary btn-cta", href: "/app" }, "Open Grimoire →"));
}

/** Render the home page; returns its teardown (the editor, and the doodle once it's loaded). */
export function renderHome(app: HTMLElement, config: Config, server: ServerInfo, signedIn: boolean): () => void {
  app.className = "home";
  document.title = "Grimoire";
  const box = h("div", { class: "home-editor", "aria-label": "Example note, try typing" });
  clear(app,
    // Above the fold: a blank page that pencils draw on (src/client/doodle, loaded below).
    h("section", { class: "home-hero" },
      h("header", { class: "home-top" },
        slab(),
        h("nav", { class: "home-nav" }, h("a", { href: "/start" }, "Getting started")),
      ),
      h("p", { class: "home-hint" }, "a notepad for people and agents ", h("span", { "aria-hidden": "true" }, "↓")),
    ),
    h("div", { class: "home-page" },
    h("main", { class: "home-main" },
      box,
      h("p", { class: "home-caption" }, "A scratch note: type in it. Nothing here is saved."),
      h("p", { class: "home-about" },
        "Grimoire is a notepad for people and agents. Notes are live, multiplayer Markdown, stored as plain files in Git. ",
        "Agents edit the same files through a shell, and you see their cursor as they write.",
      ),
      signedIn ? openApp() : viewNotes(config, server),
    ),
  ));
  const editor = localEditor(box, EXAMPLE, false);
  let unmounted = false;
  let unmountDoodle: (() => void) | null = null;
  void import("./doodle/index.ts")
    .then((m) => {
      if (!unmounted) unmountDoodle = m.mountDoodle(app);
    })
    .catch((e) => console.warn("doodle:", e));
  return () => {
    if (unmounted) return;
    unmounted = true;
    unmountDoodle?.();
    editor.destroy();
  };
}

export function renderStart(app: HTMLElement, config: Config, server: ServerInfo, signedIn: boolean) {
  app.className = "home start";
  document.title = "Getting started · Grimoire";
  const doc = h("div", { class: "start-doc" });
  clear(app, h("div", { class: "home-page" },
    h("header", { class: "home-top" },
      slab(),
      h("nav", { class: "home-nav" },
        signedIn ? h("a", { class: "btn btn-primary", href: "/app" }, "Open Grimoire") : h("a", { href: "/" }, "← Home"),
      ),
    ),
    h("main", { class: "start-main" },
      doc,
      signedIn ? openApp() : viewNotes(config, server),
    ),
  ));
  localEditor(doc, guide(location.origin), true);
}
