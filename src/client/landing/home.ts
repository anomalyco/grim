// The signed-out home page: a live example note you can type in (the real editor on a local text: nothing is synced or
// saved), under a blank page the pencils draw on.
import { mountEditor } from "../editor-rs/index.ts";
import type { ServerInfo } from "../api.ts";
import { clear, h } from "../util.ts";
import { signInDialog, signInDirect } from "../signin.ts";
import { modal } from "../dialogs.ts";
import { MAC_DOWNLOAD_PATH } from "../../shared/mac-download.ts";
// What the home page's scratch note says (it explains the product): plain Markdown, edit it there.
import HOME_NOTE from "./home-note.md" with { type: "text" };
import { markSvg } from "./mark.ts";

/** Mount the editor on a local document that never leaves the page. */
function localEditor(host: HTMLElement, text: string, readOnly: boolean) {
  return mountEditor(host, { text, readOnly });
}

/** The logo, top left: the mark (the icon's three scratches) and the wordmark, one ink on the page. */
function slab() {
  const a = h("a", { class: "home-logo", href: "/", "aria-label": "Grim home" }, h("span", { class: "home-wordmark" }, "GRIM"));
  a.prepend(markSvg(20, "home-mark"));
  return a;
}

/** The call to action: "Get started" (the demo folder, without an account). Signing in is top right. */
function tryIt() {
  const err = new URLSearchParams(location.search).get("error");
  return h("div", { class: "home-cta" },
    err ? h("p", { class: "form-error", role: "alert" }, err) : null,
    h("div", { class: "cta-row" }, h("a", { class: "btn btn-primary btn-cta", href: "/app/demo" }, "Get started"), macButton()),
  );
}

/**
 * Top right, one action: your notes when signed in, "Get started" (straight to Google sign-in, as in the app) when
 * not; none on a server without accounts. Boot has the server's answer before the page renders (/api/me is preloaded
 * with /api/server), so it's never a guess to take back.
 */
function topAction(server: ServerInfo, signedIn: boolean): HTMLElement | null {
  if (server.signIn === false) return null;
  const a = signedIn
    ? h("a", { class: "home-action", href: "/app" }, "View my notes ", h("span", { "aria-hidden": "true" }, "→"))
    : h("a", { class: "home-action", href: "/app", onclick: (e: MouseEvent) => {
        e.preventDefault();
        if (!signInDirect(server, "/app")) signInDialog(server);
      } }, "Get started");
  // faded in once: then no animation left on it, so it's plain text on the header's layer
  a.addEventListener("animationend", () => (a.style.animation = "none"), { once: true });
  return a;
}

/** Between the buttons and the footer: plain links out (new tabs), each side as far as the footer is from them. */
function linksRow() {
  const out = (href: string, text: string) => h("a", { href, target: "_blank", rel: "noopener" }, text);
  return h("nav", { class: "home-links", "aria-label": "More" },
    out("https://github.com/anomalyco/grim/blob/main/docs/self-hosting.md", "Self-hosting"),
    h("span", { class: "home-links-dot", "aria-hidden": "true" }, "·"),
    out("https://github.com/anomalyco/grim", "GitHub"),
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
  return h("div", { class: "home-cta" },
    h("div", { class: "cta-row" }, h("a", { class: "btn btn-primary btn-cta", href: "/app" }, "Open Grim →"), macButton()),
  );
}

/** Beside the call to action: the experimental Mac app, explained in a dialog before it downloads. */
function macButton() {
  return h("button", { type: "button", class: "btn btn-cta btn-mac", onclick: macDialog }, "Download macOS app");
}

function macDialog() {
  const download = h("a", { class: "btn btn-primary", href: MAC_DOWNLOAD_PATH, download: "Grim-macos.zip", onclick: () => dlg.close() }, "Download");
  const body = h("div", { class: "modal-body mac-body" },
    h("p", null, "The Mac app is experimental. It isn't signed or notarised by Apple yet, so macOS will warn you the first time you open it. We're working towards a properly signed build."),
    h("div", { class: "mac-steps" },
      h("h3", null, "To open it"),
      h("ol", null,
        h("li", null, "Unzip ", h("b", null, "Grim-macos.zip"), " and move ", h("b", null, "Grim.app"), " to Applications."),
        h("li", null, "Right-click Grim.app, choose ", h("b", null, "Open"), ", then ", h("b", null, "Open"), " again. Or try to open it once, then go to System Settings → Privacy & Security and click ", h("b", null, "Open Anyway"), "."),
      ),
      h("p", { class: "mac-term" }, "From a terminal instead: ", h("code", null, "xattr -dr com.apple.quarantine /Applications/Grim.app")),
    ),
    h("p", { class: "mac-req" }, "Needs macOS 13 or later on Apple Silicon (M1 or newer). It connects to grimnotes.app by default."),
    h("div", { class: "modal-actions" },
      h("button", { type: "button", class: "btn", onclick: () => dlg.close() }, "Cancel"),
      download,
    ),
  );
  const dlg = modal("Grim for Mac (experimental)", body, { className: "mac-modal" });
  download.focus();
}

/** Render the home page; returns its teardown (the editor, and the doodle once it's loaded). */
export function renderHome(app: HTMLElement, server: ServerInfo, signedIn: boolean): () => void {
  app.className = "home";
  document.title = "Grim";
  const box = h("div", { class: "home-editor", "aria-label": "Example note, try typing" });
  const footer = siteFooter();
  // (the top-right action fades in once and then scrolls with the header; the tagline shows only at the very top)
  const mine = topAction(server, signedIn);
  const hint = h("p", { class: "home-hint at-top-only" }, "a notepad for people and agents ", h("span", { "aria-hidden": "true" }, "↓"));
  const atTop = () => hint.classList.toggle("away", window.scrollY > 0);
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
      signedIn || server.signIn === false ? openApp() : tryIt(),
    ),
    linksRow(),
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
  let unmountWall: (() => void) | null = null;
  // The background: a plastic wall that monsters break through over a few minutes (./wall).
  void import("./wall/index.ts")
    .then((m) => {
      if (!unmounted) unmountWall = m.mountWall(app);
    })
    .catch((e) => console.warn("wall:", e));
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
    unmountWall?.();
    editor.destroy();
  };
}
