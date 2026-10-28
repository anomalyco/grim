// "Search files" (Ctrl+P): a dialog with the open folder's notes as full paths, filtered and ranked as you type.
import { h } from "./util.ts";

const MD_EXT = /\.(md|markdown|mdx)$/i;
/** Rows rendered at most (big folders: type more to narrow it down). */
export const SEARCH_LIMIT = 200;

function isSubsequence(needle: string, hay: string) {
  let i = 0;
  for (const c of hay) if (c === needle[i] && ++i === needle.length) return true;
  return needle.length === 0;
}

/**
 * The files matching `query`, best first: the name starts with it, then the name contains it, then the path does,
 * then every word is in the path (or loosely, in order, in the name), then its letters are in order in the path.
 * Ties: shorter names first (an exact name wins), then shorter paths, then by path. An empty query lists every file by path.
 */
export function rankFiles(files: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...files].sort((a, b) => a.localeCompare(b));
  const terms = q.split(/\s+/);
  const loose = q.replace(/\s+/g, "");
  const scored: Array<{ f: string; s: number; p: string; n: number }> = [];
  for (const f of files) {
    const p = f.toLowerCase().replace(MD_EXT, "");
    const name = p.slice(p.lastIndexOf("/") + 1);
    const s = name.startsWith(q) ? 0
      : name.includes(q) ? 1
      : p.includes(q) ? 2
      : terms.every((t) => p.includes(t) || (t.length > 1 && isSubsequence(t, name))) ? 3
      : isSubsequence(loose, p) ? 4
      : -1;
    if (s >= 0) scored.push({ f, s, p, n: name.length });
  }
  scored.sort((a, b) => a.s - b.s || a.n - b.n || a.p.length - b.p.length || a.f.localeCompare(b.f));
  return scored.map((x) => x.f);
}

let openDialog: HTMLDialogElement | null = null;

/** Open the dialog over `files` (`null`: still loading); `open(path)` runs for the chosen note. */
export function openFileSearch(files: readonly string[] | null, open: (path: string) => void) {
  if (openDialog) {
    openDialog.querySelector("input")?.select();
    return;
  }
  const input = h("input", {
    type: "text", class: "fs-input", placeholder: "Search files", autocomplete: "off", spellcheck: "false",
    role: "combobox", "aria-expanded": "true", "aria-controls": "fs-list", "aria-autocomplete": "list", "aria-label": "Search files",
  }) as HTMLInputElement;
  const list = h("ul", { class: "fs-list", id: "fs-list", role: "listbox", "aria-label": "Files" });
  const foot = h("p", { class: "fs-foot", hidden: true });
  const dlg = h("dialog", { class: "modal fs-modal", "aria-label": "Search files" }, h("div", { class: "fs-field" }, input), list, foot) as HTMLDialogElement;
  let shown: string[] = [];
  let sel = 0;

  const highlight = () => {
    list.querySelectorAll<HTMLElement>("[role=option]").forEach((el, i) => {
      el.setAttribute("aria-selected", String(i === sel));
      if (i === sel) {
        input.setAttribute("aria-activedescendant", el.id);
        // (scrollIntoView could scroll the dialog itself and hide the field)
        const top = el.offsetTop;
        const bottom = top + el.offsetHeight;
        if (top < list.scrollTop) list.scrollTop = top - 4;
        else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 4;
      }
    });
  };
  const render = () => {
    if (!files) {
      list.replaceChildren(h("li", { class: "fs-empty" }, "Loading…"));
      return;
    }
    const all = rankFiles(files, input.value);
    shown = all.slice(0, SEARCH_LIMIT);
    sel = 0;
    list.replaceChildren(...(shown.length ? shown.map((f, i) => {
      const p = f.replace(MD_EXT, "");
      const cut = p.lastIndexOf("/") + 1;
      return h("li", { class: "fs-item", role: "option", id: `fs-${i}`, "aria-selected": "false", title: f, onclick: () => choose(i), onmousemove: () => i !== sel && ((sel = i), highlight()) },
        cut ? h("span", { class: "fs-dir" }, p.slice(0, cut)) : null,
        h("span", { class: "fs-name" }, p.slice(cut)),
      );
    }) : [h("li", { class: "fs-empty" }, "No matching files")]));
    foot.hidden = all.length <= shown.length;
    foot.textContent = `Showing ${shown.length} of ${all.length}. Type more to narrow it down.`;
    if (!shown.length) input.removeAttribute("aria-activedescendant");
    highlight();
  };
  const choose = (i: number) => {
    const f = shown[i];
    if (f === undefined) return;
    dlg.close();
    open(f);
  };
  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length) sel = Math.max(0, Math.min(shown.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1)));
      highlight();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(sel);
    }
  });
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close();
  });
  dlg.addEventListener("close", () => {
    dlg.remove();
    openDialog = null;
  });
  openDialog = dlg;
  document.body.appendChild(dlg);
  render();
  dlg.showModal();
  input.focus();
}
