// The signed-out home page: a live example note you can type in (the real editor on a local text: nothing is synced or
// saved), under a blank page the pencils draw on.
import { mountEditor } from "./editor-rs/index.ts";
import type { Config, ServerInfo } from "./api.ts";
import { clear, h } from "./util.ts";
import { signInDialog, signInDirect } from "./signin.ts";

const EXAMPLE = `# Grimoire
Type here: it's a **live** Markdown note. Try *italic*, ==highlight== or \`code\`.

- Plain Markdown files, stored in Git
- Everyone sees edits and cursors as they happen
- [x] Write a note
- [ ] Hand it to an agent

> Edits are committed as you go.`;

/** Mount the editor on a local document that never leaves the page. */
function localEditor(host: HTMLElement, text: string, readOnly: boolean) {
  return mountEditor(host, { text, readOnly });
}

function slab() {
  return h("a", { class: "slab-blk", href: "/", "aria-label": "Grimoire home" }, "GRIMOIRE");
}

/**
 * The call to action: "View the notes" (the demo folder, without an account) and "Sign in" (the server's sign-in methods in
 * a dialog).
 */
function viewNotes(config: Config, server: ServerInfo) {
  const err = new URLSearchParams(location.search).get("error");
  return h("div", { class: "home-cta" },
    err ? h("p", { class: "form-error", role: "alert" }, err) : null,
    h("div", { class: "cta-row" },
      h("a", { class: "btn btn-primary btn-cta", href: "/app/demo" }, "View the notes"),
      h("a", { class: "cta-signin", href: "/app", onclick: (e: MouseEvent) => {
        e.preventDefault();
        if (!signInDirect(config, server)) signInDialog(config, server);
      } }, "Sign in"),
    ),
  );
}

/** hokum.app's footer (and opentunnel's): the Anomaly copyright on black, its signature (signature.ts, loaded after
 *  first paint) faintly behind the line. */
function siteFooter() {
  return h("footer", { class: "site-footer" },
    h("div", { class: "copyright" },
      h("p", {}, "©2026 ", h("a", { href: "https://anoma.ly" }, "anomaly"), ". all rights reserved"),
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
  const footer = siteFooter();
  clear(app,
    // Above the fold: a blank page that pencils draw on (src/client/doodle, loaded below).
    h("section", { class: "home-hero" },
      h("header", { class: "home-top" }, slab()),
      h("p", { class: "home-hint", onclick: () => app.querySelector(".home-page")?.scrollIntoView({ behavior: "smooth" }) },
        "a notepad for people and agents ", h("span", { "aria-hidden": "true" }, "↓")),
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
    ),
    footer,
  );
  const editor = localEditor(box, EXAMPLE, false);
  let unmounted = false;
  void import("./signature.ts")
    .then((m) => footer.querySelector(".copyright")?.insertAdjacentHTML("afterbegin", m.SIGNATURE))
    .catch((e) => console.warn("signature:", e));
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
