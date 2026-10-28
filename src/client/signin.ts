// Visitors who aren't signed in: the made-up identity this browser shows on its cursor and commits (no account), and
// the sign-in dialog.
import { sillyName } from "../shared/names.ts";
import type { Config, ServerInfo } from "./api.ts";
import { modal } from "./dialogs.ts";
import { colorFor, h } from "./util.ts";

export interface AnonIdentity {
  /** Random, this browser's; rooms show it as "guest:<id>". */
  id: string;
  name: string;
  color: string;
}

const ANON_KEY = "grimoire.anon.v1";

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** This browser's guest identity (made and kept in localStorage the first time). */
export function anonIdentity(): AnonIdentity {
  try {
    const raw = JSON.parse(localStorage.getItem(ANON_KEY) ?? "null") as Partial<AnonIdentity> | null;
    if (raw && typeof raw.id === "string" && /^[A-Za-z0-9_-]{6,40}$/.test(raw.id) && typeof raw.name === "string" && /^[a-z]+-[a-z]+$/.test(raw.name) && typeof raw.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color))
      return { id: raw.id, name: raw.name, color: raw.color };
  } catch {}
  const id = randomId();
  const me = { id, name: sillyName(), color: colorFor(id) };
  try {
    localStorage.setItem(ANON_KEY, JSON.stringify(me));
  } catch {}
  return me;
}

/** Why the dialog opened: creating or opening folders (the only things a guest can't do), or just "Sign in". */
export type SignInReason = "folders" | null;

function reasonLine(reason: SignInReason): string {
  if (reason === "folders") return "You need to sign in to create folders. It's free.";
  return "Sign in to create and open folders and to hand a folder to an agent. It's free.";
}

/** Where signing in from here lands: this /app page (the same note), else the app. */
export function signInNext() {
  return location.pathname === "/app" || location.pathname.startsWith("/app/") ? location.pathname + location.search : "/app";
}

const G_MARK = '<svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62ZM9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Zm-5.03-7.28A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33ZM9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"/></svg>';

/** The sign-in methods this server has: Google, GitHub, a name (each lands on `next`). */
export function signInOptions(config: Config, server: ServerInfo, next: string, name = ""): HTMLElement {
  const google = server.google
    ? (() => {
        const a = h("a", { class: "btn btn-primary btn-signin btn-google", href: `/auth/google?next=${encodeURIComponent(next)}` });
        a.innerHTML = G_MARK;
        a.append("Continue with Google");
        return a;
      })()
    : null;
  const github = config.githubLogin ? h("a", { class: `btn btn-signin${google ? "" : " btn-primary"}`, href: `/auth/github?next=${encodeURIComponent(next)}` }, "Continue with GitHub") : null;
  const named = server.devLogin
    ? h("form", { class: "signin-name", method: "post", action: "/auth/dev" },
        h("input", { type: "hidden", name: "next", value: next }),
        h("input", { type: "text", name: "name", value: name, required: true, maxlength: "60", autocomplete: "off", spellcheck: "false", "aria-label": "Your name", placeholder: "Your name" }),
        h("button", { type: "submit", class: google || github ? "btn" : "btn btn-primary" }, "Continue with a name"),
        h("p", { class: "hint" }, "Creates a new account with this name."),
      )
    : null;
  return h("div", { class: "signin-options" },
    google,
    github,
    (google || github) && named ? h("div", { class: "signin-or" }, h("span", null, "or")) : null,
    named,
    !google && !github && !named ? h("p", { class: "form-error" }, "No sign-in method is configured on this server.") : null,
  );
}

/**
 * The sign-in dialog: why (`reason`), the server's sign-in methods (back to this page after), "Play in a scratch note
 * instead" (`scratch`: the URL, with the open note's text), "Try the demo folder" (`demo`) and Close.
 */
export function signInDialog(config: Config, server: ServerInfo, opts: { reason?: SignInReason; name?: string; scratch?: string | null; demo?: boolean } = {}) {
  document.querySelector<HTMLDialogElement>("dialog.signin-modal[open]")?.close();
  const reason = opts.reason ?? null;
  const body = h("div", { class: "modal-body signin-body" },
    h("p", { class: "signin-why" }, reasonLine(reason)),
    signInOptions(config, server, signInNext(), opts.name ?? ""),
    h("div", { class: "modal-actions signin-actions" },
      opts.scratch ? h("a", { class: "signin-scratch", href: opts.scratch }, "Play in a scratch note instead") : null,
      opts.demo ? h("a", { class: "signin-scratch signin-demo", href: "/app/demo" }, "Try the demo folder") : null,
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "btn", onclick: () => dlg.close() }, "Close"),
    ),
  );
  const dlg = modal("Sign in", body);
  dlg.classList.add("signin-modal");
  body.querySelector<HTMLElement>(".btn-google, .signin-name input[name=name], .btn")?.focus();
  return dlg;
}
