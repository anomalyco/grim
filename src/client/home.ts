// Signed-out pages: the home page (a live example note you can type in) and /start (the getting-started guide).
// Both use the real editor on a local text: nothing is synced or saved.
import { sillyName } from "../shared/names.ts";
import { mountEditor } from "./editor-rs/index.ts";
import type { Config, ServerInfo } from "./api.ts";
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
Sign in on the home page. Notes live in folders (each one is a Git repo of Markdown files); the first one is called **Notes**. The folder menu at the top left of the sidebar switches between them, makes new ones and shares them.

## 2. Create a note
Click **+ New note** in the sidebar and give it a path. Slashes make subfolders: \`projects/ideas.md\` goes in \`projects\`. Press \`/\` to filter your files.

## 3. Write together
Open the same note as someone else and you both see edits and cursors live. Markdown renders as you type: \`#\` headings, \`-\` lists, \`- [ ]\` todos, \`**bold**\`, \`==highlight==\`.

## 4. History and restore
Notes save themselves: each one is committed to Git a few seconds after you stop typing. Open **History** to see versions and diffs, and restore an older one.

## 5. Link a GitHub repo
Open the folder menu, choose **Open…** and then **GitHub repo**, and paste a repo URL. Public repos are added as read-only copies that stay up to date with GitHub; editing a repo (synced both ways) needs the GitHub App installed on it.

## 6. Connect an agent
Open the folder menu and choose **Share with agent…**. It shows a prompt with your link for that notebook (the same link every time) to copy and paste to your agent:
\`\`\`
Work in this Grimoire notebook: ${origin}/a/…
\`\`\`
The link is the agent's way in: a GET returns instructions, and each POST runs a shell command in the notebook, which is a folder of Markdown files. Its edits show up live, with its own cursor. Anyone with the link can do in that notebook what you can, so only give it to agents you trust.

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

/** Where signing in from this page lands: the /app link it was opened at, else the app. */
function nextPath() {
  return location.pathname === "/app" || location.pathname.startsWith("/app/") ? location.pathname + location.search : "/app";
}

const G_MARK = '<svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62ZM9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Zm-5.03-7.28A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33ZM9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"/></svg>';

/** "Continue with Google": back to this page's /app link after. */
function googleButton(cls = "btn btn-primary btn-cta btn-google") {
  const a = h("a", { class: cls, href: `/auth/google?next=${encodeURIComponent(nextPath())}` });
  a.innerHTML = G_MARK;
  a.append("Continue with Google");
  return a;
}

/**
 * The call to action. Open servers: a name (pre-filled) and "View the notes" (plus Google when it's set up);
 * servers limited to some emails: only "Continue with Google". Signing in lands on the app (or the /app link
 * this page was opened at).
 */
function signIn(config: Config, server: ServerInfo) {
  const err = new URLSearchParams(location.search).get("error");
  const next = nextPath();
  const github = `/auth/github?next=${encodeURIComponent(next)}`;
  if (server.signin === "emails") {
    return h("div", { class: "home-cta" },
      err ? h("p", { class: "form-error", role: "alert" }, err) : null,
      server.google ? googleButton() : h("p", { class: "form-error" }, "No sign-in method is configured on this server."),
    );
  }
  return h("div", { class: "home-cta" },
    err ? h("p", { class: "form-error", role: "alert" }, err) : null,
    config.devLogin
      ? h("form", { class: "cta-form", method: "post", action: "/auth/dev" },
          h("input", { type: "hidden", name: "next", value: next }),
          h("label", { class: "cta-label", for: "cta-name" }, "Name:"),
          h("input", { type: "text", id: "cta-name", name: "name", value: sillyName(), required: true, maxlength: "60", autocomplete: "off", spellcheck: "false" }),
          h("button", { type: "submit", class: "btn btn-primary btn-cta" }, "View the notes"),
        )
      : config.githubLogin
        ? h("a", { class: "btn btn-primary btn-cta", href: github }, "View the notes")
        : h("p", { class: "form-error" }, "No sign-in method is configured on this server."),
    config.devLogin && config.githubLogin ? h("a", { class: "cta-alt", href: github }, "or sign in with GitHub") : null,
    server.google ? h("a", { class: "cta-alt cta-google", href: `/auth/google?next=${encodeURIComponent(next)}` }, "or continue with Google") : null,
  );
}

/**
 * Signed out at a workspace (or note) that isn't open to everyone: a calm sign-in screen, not the home page.
 * `what`: null when the app itself was opened (e.g. /app on a server limited to some emails).
 */
export function renderWorkspaceSignIn(app: HTMLElement, config: Config, server: ServerInfo, what: "workspace" | "note" | null) {
  app.className = "home signin";
  document.title = "Sign in · Grimoire";
  const err = new URLSearchParams(location.search).get("error");
  const nameSignIn = server.signin === "open" && config.devLogin;
  const next = nextPath();
  clear(app, h("div", { class: "signin-page" },
    h("main", { class: "signin-card" },
      slab(),
      h("h1", null, what === "workspace" ? "Sign in to view this folder" : what === "note" ? "Sign in to view this note" : "Sign in to Grimoire"),
      h("p", { class: "muted" }, what ? `It's private on ${location.host}. Sign in with an account that has access.` : `Sign in to open your folders on ${location.host}.`),
      err ? h("p", { class: "form-error", role: "alert" }, err) : null,
      server.google ? googleButton("btn btn-primary btn-signin btn-google") : null,
      server.google && nameSignIn ? h("div", { class: "signin-or" }, h("span", null, "or")) : null,
      nameSignIn
        ? h("form", { class: "signin-name", method: "post", action: "/auth/dev" },
            h("input", { type: "hidden", name: "next", value: next }),
            h("input", { type: "text", name: "name", value: sillyName(), required: true, maxlength: "60", autocomplete: "off", spellcheck: "false", "aria-label": "Your name" }),
            h("button", { type: "submit", class: server.google ? "btn" : "btn btn-primary" }, "Continue with a name"),
          )
        : null,
      !server.google && !nameSignIn ? h("p", { class: "form-error" }, "No sign-in method is configured on this server.") : null,
      h("a", { class: "cta-alt", href: "/" }, "Grimoire home"),
    ),
  ));
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
      signedIn ? openApp() : signIn(config, server),
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
      signedIn ? openApp() : signIn(config, server),
    ),
  ));
  localEditor(doc, guide(location.origin), true);
}
