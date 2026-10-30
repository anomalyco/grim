// /scratch: a scratch note, the real editor on a local text that lives only in this browser (localStorage). Nothing
// goes to the server: no room, no saves. `?from=<folder>/<path>` starts it with a copy of that note's text (read once,
// then the URL becomes /scratch so a reload keeps what was typed).
import { mountEditor, type EditorHandle } from "./editor-rs/index.ts";
import type { LocalSync, RustEditorView } from "./editor-rs/view.ts";
import { api } from "./api.ts";
import { confirmDialog } from "./dialogs.ts";
import { clear, debounce, h, toast } from "./util.ts";

const KEY = "grimoire.scratch.v1";

export const SCRATCH_DEMO = `# Scratch note
Type here: it's a **live** Markdown note that stays in this browser. Try *italic*, ==highlight== or \`code\`.

- Lists, [links](https://example.com) and \`- [ ]\` todos
- [x] Play with the editor
- [ ] Sign in to keep notes in Grim

> Nothing here is sent anywhere.`;

function stored(): { text: string; from?: string } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as { text?: unknown; from?: unknown } | null;
    if (raw && typeof raw.text === "string") return { text: raw.text, ...(typeof raw.from === "string" ? { from: raw.from } : {}) };
  } catch {}
  return null;
}

function store(text: string, from?: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ text, ...(from ? { from } : {}) }));
  } catch {
    toast("Couldn't keep the scratch note in this browser (storage is full or off).", "error");
  }
}

/** `<folder>/<path>` from ?from=: the note, or null. */
function parseFrom(raw: string | null): { repo: string; path: string } | null {
  if (!raw) return null;
  const i = raw.indexOf("/");
  if (i <= 0 || i === raw.length - 1) return null;
  const repo = raw.slice(0, i);
  const path = raw.slice(i + 1);
  if (repo === "." || repo === ".." || path.split("/").some((s) => !s || s === "." || s === "..")) return null;
  return { repo, path };
}

const noteUrl = (n: { repo: string; path: string }) => `/app/${encodeURIComponent(n.repo)}/${n.path.split("/").map(encodeURIComponent).join("/")}`;

export async function renderScratch(app: HTMLElement) {
  app.className = "home scratch";
  document.title = "Scratch note · Grim";
  const params = new URLSearchParams(location.search);
  const fromRaw = params.get("from");
  const from = parseFrom(fromRaw);
  let text = stored()?.text ?? SCRATCH_DEMO;
  let source = stored()?.from;
  if (from) {
    try {
      text = (await api.file(from.repo, from.path)).content;
      source = `${from.repo}/${from.path}`;
      store(text, source);
    } catch {
      toast("Couldn't copy that note; here's your scratch note as it was.", "error");
    }
    window.history.replaceState(null, "", "/scratch");
  }
  const back = h("a", { class: "scratch-back", href: from ? noteUrl(from) : (parseFrom(source ?? null) ? noteUrl(parseFrom(source!)!) : "/app") }, "← Back to the notes");
  const host = h("div", { class: "start-doc scratch-doc" });
  let editor: EditorHandle | null = null;
  const save = debounce(() => editor && store(editor.text() ?? "", source), 300);
  // the local document's edits, to keep the text (nothing else is shared)
  const keep: LocalSync = {
    attach: (_v: RustEditorView) => {},
    push: () => save(),
    resync: () => save(),
    selectionChanged: () => {},
    peerCursors: () => [],
    detach: () => {},
  };
  const mount = (t: string) => {
    editor?.destroy();
    host.replaceChildren();
    editor = mountEditor(host, { text: t, sync: keep });
    editor.focus();
  };
  const clearBtn = h("button", { type: "button", class: "btn btn-small", onclick: async () => {
    if (!(await confirmDialog({ title: "Clear the scratch note", message: "Clear the scratch note? Its text is only in this browser, so it's gone for good.", confirm: "Clear", danger: true }))) return;
    source = undefined;
    store("");
    mount("");
  } }, "Clear");
  clear(app, h("div", { class: "home-page" },
    h("header", { class: "home-top scratch-top" },
      h("a", { class: "slab-blk", href: "/", "aria-label": "Grim home" }, "GRIM"),
      h("nav", { class: "home-nav" }, back),
    ),
    h("div", { class: "scratch-banner", role: "note" },
      h("span", null, h("b", null, "Scratch note"), " — only in this browser, not saved to Grim"),
      clearBtn,
    ),
    h("main", { class: "start-main" }, host),
  ));
  mount(text);
  window.addEventListener("pagehide", () => editor && store(editor.text() ?? "", source));
}
