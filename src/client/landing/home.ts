// The signed-out home page: a live example note you can type in (the real editor on a local text: nothing is synced or
// saved), under a blank page the pencils draw on.
import { mountEditor } from "../editor-rs/index.ts";
import type { Config, ServerInfo } from "../api.ts";
import { clear, h } from "../util.ts";
import { signInDialog, signInDirect } from "../signin.ts";
// What the home page's scratch note says (it explains the product): plain Markdown, edit it there.
import HOME_NOTE from "./home-note.md" with { type: "text" };

/** Mount the editor on a local document that never leaves the page. */
function localEditor(host: HTMLElement, text: string, readOnly: boolean) {
  return mountEditor(host, { text, readOnly });
}

function slab() {
  return h("a", { class: "slab-blk", href: "/", "aria-label": "Grimoire home" }, "GRIMOIRE");
}

/** The call to action: "Try it out" (the demo folder, without an account). Signing in is top right. */
function tryIt() {
  const err = new URLSearchParams(location.search).get("error");
  return h("div", { class: "home-cta" },
    err ? h("p", { class: "form-error", role: "alert" }, err) : null,
    h("div", { class: "cta-row" }, h("a", { class: "btn btn-primary btn-cta", href: "/app/demo" }, "Try it out")),
  );
}

/**
 * Top right, one action: your notes when signed in, "Sign in" (straight to Google, as in the app) when not; none on a
 * server without accounts. Boot has the server's answer before the page renders (/api/me is preloaded with the
 * config), so it's never a guess to take back.
 */
function topAction(config: Config, server: ServerInfo, signedIn: boolean): HTMLElement | null {
  if (config.signIn === false) return null;
  if (signedIn) return h("a", { class: "home-action", href: "/app" }, "View my notes ", h("span", { "aria-hidden": "true" }, "→"));
  return h("a", { class: "home-action", href: "/app", onclick: (e: MouseEvent) => {
    e.preventDefault();
    if (!signInDirect(config, server, "/app")) signInDialog(config, server);
  } }, "Sign in");
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
  // (the top-right action and the hint show only while the page is at its very top)
  const mine = topAction(config, server, signedIn);
  const hint = h("p", { class: "home-hint at-top-only" }, "a notepad for people and agents");
  mine?.classList.add("at-top-only");
  const atTop = () => {
    for (const el of [mine, hint]) el?.classList.toggle("away", window.scrollY > 0);
  };
  clear(app,
    // Above the fold: a blank page that pencils draw on (src/client/doodle, loaded below).
    h("section", { class: "home-hero" },
      h("header", { class: "home-top" }, slab(), mine),
      hint,
    ),
    h("div", { class: "home-page" },
    h("main", { class: "home-main" },
      box,
      // (a server without sign-in: everyone goes straight in)
      signedIn || config.signIn === false ? openApp() : tryIt(),
    ),
    ),
    footer,
  );
  const editor = localEditor(box, HOME_NOTE.trimEnd(), false);
  atTop();
  window.addEventListener("scroll", atTop, { passive: true });
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
    window.removeEventListener("scroll", atTop);
    unmountDoodle?.();
    editor.destroy();
  };
}
