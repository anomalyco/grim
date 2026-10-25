// App shell: login, sidebar (repos, file tree, search), document header, editor session, history, routing.
import * as Y from "yjs";
import { mountEditor } from "./editor/index.ts";
import { api, ApiError, subscribeEvents, type AppEvent, type Config, type Me, type PresenceUserInfo, type Repo, type SearchHit, type Tree } from "./api.ts";
import { NotepadProvider, type ClosedReason } from "./provider.ts";
import { HistoryPanel } from "./history.ts";
import { agentTokensDialog, confirmDialog, linkGitHubDialog, promptDialog } from "./dialogs.ts";
import { avatar, basename, clear, colorFor, debounce, displayName, errorMessage, h, relativeTime, shortSha, toast, validPeerUser } from "./util.ts";
import type { PresenceState } from "../shared/presence.ts";

// ---------- state ----------

let config: Config;
let me: Me;
let repos: Repo[] = [];
const trees = new Map<string, Tree | { error: string }>();
const expandedRepos = new Set<string>();
const collapsedFolders = new Set<string>();
const presence = new Map<string, PresenceUserInfo[]>();
let current: { repo: string; path: string } | null = null;
let selectedRepo: string | null = null;
let session: Session | null = null;
let routeSeq = 0;
const search = {
  query: "",
  seq: 0,
  /** The repo the results (or the pending request) belong to. */
  repo: null as string | null,
  hits: null as SearchHit[] | null,
  error: null as string | null,
};

const fkey = (repo: string, path: string) => `${repo}\u0000${path}`;
const repoById = (id: string | null) => (id ? repos.find((r) => r.id === id) : undefined);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MD_EXT = /\.(md|markdown|mdx)$/i;

// ---------- elements ----------

const app = document.getElementById("app")!;
const treeEl = h("nav", { class: "sb-tree", "aria-label": "Notes" });
const searchInput = h("input", { type: "search", class: "sb-search-input", placeholder: "Search…", autocomplete: "off", spellcheck: "false", "aria-label": "Search notes" });
const breadcrumbEl = h("div", { class: "breadcrumb" });
const participantsEl = h("div", { class: "participants" });
const saveStatusEl = h("div", { class: "save-status", "aria-live": "polite" });
const historyBtn = h("button", { type: "button", class: "btn btn-ghost", disabled: true }, "History");
const docBody = h("div", { class: "doc-body" });
const history = new HistoryPanel((open) => {
  historyBtn.classList.toggle("active", open);
  app.classList.toggle("history-open", open);
});
let menuEl: HTMLElement | null = null;
let menuOpener: HTMLElement | null = null;

// ---------- boot ----------

void boot();

async function boot() {
  try {
    config = await api.config();
  } catch (err) {
    clear(app, h("div", { class: "fatal" }, "Couldn't reach the server: ", errorMessage(err)));
    return;
  }
  try {
    me = await api.me();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return renderLogin();
    clear(app, h("div", { class: "fatal" }, errorMessage(err)));
    return;
  }
  renderShell();
  subscribeEvents(onEvent, (reconnect) => {
    // The server sends a presence snapshot on every connect.
    presence.clear();
    renderTree();
    if (reconnect) void loadRepos(true);
  });
  await loadRepos();
  await route();
  window.addEventListener("popstate", () => void route());
  setInterval(renderSaveStatus, 30_000);
}

// ---------- login ----------

function renderLogin() {
  app.className = "login-page";
  const err = new URLSearchParams(location.search).get("error");
  const name = h("input", { type: "text", name: "name", placeholder: "Your name", required: true, autocomplete: "name" });
  clear(app, h("div", { class: "login-card" },
    h("div", { class: "logo" }, "✎"),
    h("h1", null, "Notepad"),
    h("p", { class: "muted" }, "Multiplayer Markdown notes, stored in Git."),
    err ? h("p", { class: "form-error" }, err) : null,
    config.githubLogin
      ? h("a", { class: "btn btn-github", href: "/auth/github" }, githubIcon(), "Sign in with GitHub")
      : null,
    config.githubLogin && config.devLogin ? h("div", { class: "or" }, h("span", null, "or")) : null,
    config.devLogin
      ? h("form", { class: "dev-login", method: "post", action: "/auth/dev" },
          name,
          h("button", { type: "submit", class: "btn btn-primary" }, "Continue"),
          h("p", { class: "hint" }, "Development sign-in"),
        )
      : null,
    !config.githubLogin && !config.devLogin ? h("p", { class: "form-error" }, "No sign-in method is configured on this server.") : null,
  ));
  if (config.devLogin && !config.githubLogin) name.focus();
}

function githubIcon() {
  const span = h("span", { "aria-hidden": "true", style: { display: "inline-flex" } });
  span.innerHTML = `<svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
  return span;
}


// ---------- shell ----------

function renderShell() {
  app.className = "app";
  const userBtn = h("button", { type: "button", class: "user-btn", title: me.name, "aria-haspopup": "menu" },
    avatar({ id: me.id, name: me.name, color: me.color, avatar: me.avatar }),
    h("span", { class: "user-name" }, me.name),
  );
  userBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showMenuBelow(userBtn, [
      me.isAdmin ? { label: "Agent tokens…", run: () => agentTokensDialog() } : null,
      { label: "Sign out", run: logout },
    ]);
  });

  const moreBtn = h("button", { type: "button", class: "btn btn-icon", title: "More", "aria-label": "More actions", "aria-haspopup": "menu" }, "⋯");
  moreBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showMenuBelow(moreBtn, [
      { label: "New notebook…", run: newNotebook },
      { label: "Link GitHub repo…", run: linkRepo },
    ]);
  });

  searchInput.addEventListener("input", () => runSearch());
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      runSearch();
    }
  });

  historyBtn.addEventListener("click", () => history.toggle());

  clear(app,
    h("aside", { class: "sidebar" },
      h("div", { class: "sb-head" },
        h("a", { class: "brand", href: "/", onclick: (e: MouseEvent) => (e.preventDefault(), goHome()) }, h("span", { class: "logo-sm" }, "✎"), "Notepad"),
        userBtn,
      ),
      h("div", { class: "sb-actions" },
        h("button", { type: "button", class: "btn btn-primary btn-block", onclick: () => void newNote() }, "+ New note"),
        moreBtn,
      ),
      h("div", { class: "sb-search" }, searchInput),
      treeEl,
    ),
    h("div", { class: "sidebar-backdrop", onclick: () => setSidebarOpen(false) }),
    h("main", { class: "main" },
      h("header", { class: "doc-header" },
        h("button", { type: "button", class: "icon-btn sidebar-toggle", "aria-label": "Toggle sidebar", onclick: () => setSidebarOpen(!app.classList.contains("sidebar-open")) }, "☰"),
        breadcrumbEl, h("div", { class: "spacer" }), participantsEl, saveStatusEl, historyBtn,
      ),
      docBody,
    ),
    history.el,
  );

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      session?.flush();
    }
  }, true);
  document.addEventListener("click", () => closeMenu());
  window.addEventListener("blur", () => closeMenu());
}

function setSidebarOpen(open: boolean) {
  app.classList.toggle("sidebar-open", open);
}

async function logout() {
  try {
    await api.logout();
  } catch {}
  location.href = "/";
}

// ---------- data ----------

/** Reload the repo list and the trees of expanded repos (all loaded trees when `refresh`). */
async function loadRepos(refresh = false) {
  try {
    repos = await api.repos();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return location.reload();
    toast(`Couldn't load repos: ${errorMessage(err)}`, "error");
  }
  for (const id of [...trees.keys()]) if (!repoById(id)) trees.delete(id);
  if (repos.length && expandedRepos.size === 0) {
    for (const r of repos) if (r.kind === "notes") expandedRepos.add(r.id);
  }
  const ids = repos.map((r) => r.id).filter((id) => (refresh && trees.has(id)) || (expandedRepos.has(id) && !trees.has(id)));
  await Promise.all(ids.map((id) => loadTree(id, false)));
  renderTree();
  renderHeader();
  updateSearchRepo();
}

async function loadTree(id: string, render = true) {
  try {
    trees.set(id, await api.tree(id));
  } catch (err) {
    trees.set(id, { error: errorMessage(err) });
  }
  if (render) renderTree();
}

function onEvent(e: AppEvent) {
  switch (e.type) {
    case "tree":
      if (trees.has(e.repo)) void loadTree(e.repo);
      if (search.query && search.repo === e.repo) runSearch();
      break;
    case "repos":
      void loadRepos();
      break;
    case "presence": {
      const key = fkey(e.repo, e.path);
      const users = (Array.isArray(e.users) ? e.users : []).map(validPeerUser).filter((u) => u !== null);
      if (users.length) presence.set(key, users);
      else presence.delete(key);
      renderTree();
      break;
    }
    case "saved":
      history.onSaved(e.repo, e.path);
      break;
  }
}

// ---------- sidebar ----------

interface Folder {
  name: string;
  path: string;
  folders: Map<string, Folder>;
  files: string[];
}

function buildFolders(files: string[]): Folder {
  const root: Folder = { name: "", path: "", folders: new Map(), files: [] };
  for (const f of files) {
    const parts = f.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!;
      let next = node.folders.get(name);
      if (!next) {
        next = { name, path: parts.slice(0, i + 1).join("/"), folders: new Map(), files: [] };
        node.folders.set(name, next);
      }
      node = next;
    }
    node.files.push(f);
  }
  return root;
}

function renderTree() {
  const scroll = treeEl.scrollTop;
  // Re-rendering replaces the rows; keep keyboard focus on the same row.
  const focusKey = (document.activeElement as HTMLElement | null)?.closest?.("[data-key]")?.getAttribute("data-key");
  if (search.query) renderSearchResults();
  else if (!repos.length) {
    clear(treeEl, h("div", { class: "empty" }, h("p", null, "No notebooks yet."), h("button", { class: "btn", type: "button", onclick: newNotebook }, "Create a notebook")));
  } else clear(treeEl, h("ul", { role: "tree" }, repos.map(renderRepo)));
  treeEl.scrollTop = scroll;
  if (focusKey && document.activeElement === document.body) {
    treeEl.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
  }
}

/** Make a row act like a button for the keyboard: Enter/Space activate, the context-menu key opens its menu. */
function rowKeys(el: HTMLElement, activate: () => void, menu: () => MenuItem[]) {
  el.addEventListener("keydown", (e) => {
    if (e.target !== el) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      showMenuBelow(el, menu());
    }
  });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, menu(), el);
  });
}

function renderRepo(repo: Repo) {
  const open = expandedRepos.has(repo.id);
  const tree = trees.get(repo.id);
  const writable = repo.access === "write" && !repo.readOnly;
  const toggle = async () => {
    selectedRepo = repo.id;
    updateSearchRepo();
    if (open) expandedRepos.delete(repo.id);
    else {
      expandedRepos.add(repo.id);
      if (!trees.has(repo.id)) await loadTree(repo.id, false);
    }
    renderTree();
  };
  const menuItems = (): MenuItem[] => [
    writable ? { label: "New note here…", run: () => void newNote(repo.id) } : null,
    repo.kind === "github" && repo.ghOwner ? { label: "Open on GitHub", run: () => window.open(`https://github.com/${repo.ghOwner}/${repo.ghName}`, "_blank", "noopener") } : null,
    { label: "Refresh", run: () => void loadTree(repo.id) },
    me.isAdmin ? { label: "Remove…", danger: true, run: () => void removeRepo(repo) } : null,
  ];
  const row = h("div", { class: `repo-row${selectedRepo === repo.id ? " selected" : ""}`, role: "treeitem", tabindex: "0", "aria-expanded": String(open), "data-key": `repo:${repo.id}`, onclick: toggle, title: repo.error ?? repo.title },
    h("span", { class: `caret${open ? " open" : ""}` }, "▸"),
    h("span", { class: "repo-icon" }, repo.kind === "github" ? "⌥" : "▤"),
    h("span", { class: "repo-title" }, repo.title),
    repo.status === "importing" ? h("span", { class: "badge badge-busy" }, "importing") : null,
    repo.status === "error" ? h("span", { class: "badge badge-error", title: repo.error ?? "" }, "error") : null,
    repo.readOnly || repo.access === "read" ? h("span", { class: "badge" }, "read-only") : null,
    h("span", { class: "row-actions" },
      writable
        ? h("button", { type: "button", class: "icon-btn", title: "New note", "aria-label": `New note in ${repo.title}`, onclick: (e: MouseEvent) => (e.stopPropagation(), void newNote(repo.id)) }, "+")
        : null,
      h("button", { type: "button", class: "icon-btn", title: "More", "aria-label": `${repo.title} actions`, "aria-haspopup": "menu", onclick: (e: MouseEvent) => (e.stopPropagation(), showMenuBelow(e.currentTarget as HTMLElement, menuItems())) }, "⋯"),
    ),
  );
  rowKeys(row, () => void toggle(), menuItems);

  let children: HTMLElement | null = null;
  if (open) {
    if (!tree) children = h("div", { class: "tree-note" }, "Loading…");
    else if ("error" in tree) children = h("div", { class: "tree-note error" }, repo.status === "importing" ? "Importing…" : tree.error);
    else if (!tree.files.length) children = h("div", { class: "tree-note" }, repo.status === "importing" ? "Importing…" : "No notes yet.");
    else children = renderFolder(repo, buildFolders(tree.files), 1);
  }
  return h("li", { class: "repo" }, row, children);
}

function renderFolder(repo: Repo, folder: Folder, depth: number): HTMLElement {
  const ul = h("ul", { role: "group" });
  const folders = [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const f of folders) {
    const key = fkey(repo.id, f.path);
    const collapsed = collapsedFolders.has(key);
    const toggle = () => {
      if (collapsed) collapsedFolders.delete(key);
      else collapsedFolders.add(key);
      renderTree();
    };
    const row = h("div", { class: "folder-row", role: "treeitem", tabindex: "0", "aria-expanded": String(!collapsed), "data-key": `dir:${key}`, style: { "--depth": String(depth) }, onclick: toggle },
      h("span", { class: `caret${collapsed ? "" : " open"}` }, "▸"),
      h("span", { class: "folder-name" }, f.name),
    );
    rowKeys(row, toggle, () => []);
    ul.appendChild(h("li", null, row, collapsed ? null : renderFolder(repo, f, depth + 1)));
  }
  for (const path of folder.files) ul.appendChild(h("li", null, renderFile(repo, path, depth)));
  return ul;
}

function renderFile(repo: Repo, path: string, depth: number) {
  const active = current?.repo === repo.id && current.path === path;
  const users = (presence.get(fkey(repo.id, path)) ?? []).filter((u) => u.id !== me.id);
  const writable = repo.access === "write" && !repo.readOnly;
  const items = (): MenuItem[] => [
    { label: "Open", run: () => navigate(repo.id, path) },
    writable ? { label: "Rename…", run: () => void renameFile(repo, path) } : null,
    writable ? { label: "Delete…", danger: true, run: () => void deleteFile(repo, path) } : null,
  ];
  const a = h("a", { class: `file-row${active ? " active" : ""}`, href: urlFor(repo.id, path), role: "treeitem", "aria-current": active ? "page" : undefined, "data-key": `file:${fkey(repo.id, path)}`, style: { "--depth": String(depth) }, title: path },
    h("span", { class: "file-name" }, displayName(path)),
    users.length
      ? h("span", { class: "presence-dots", "aria-label": `${users.map((u) => u.name).join(", ")} here` }, users.slice(0, 4).map((u) => avatar(u, "sm")), users.length > 4 ? h("span", { class: "more" }, `+${users.length - 4}`) : null)
      : null,
    h("button", { type: "button", class: "icon-btn row-menu", title: "More", "aria-label": `${displayName(path)} actions`, "aria-haspopup": "menu", onclick: (e: MouseEvent) => (e.preventDefault(), e.stopPropagation(), showMenuBelow(e.currentTarget as HTMLElement, items())) }, "⋯"),
  );
  a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(repo.id, path);
  });
  a.addEventListener("keydown", (e) => {
    if (e.target === a && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) {
      e.preventDefault();
      showMenuBelow(a, items());
    }
  });
  a.addEventListener("contextmenu", (e) => (e.preventDefault(), e.stopPropagation(), showMenu(e.clientX, e.clientY, items(), a)));
  return a;
}

// ---------- search ----------

function searchRepoId() {
  return current?.repo ?? selectedRepo ?? repos[0]?.id ?? null;
}

/** Update the placeholder and re-run the search if the repo it applies to changed. */
function updateSearchRepo() {
  const id = searchRepoId();
  const repo = repoById(id);
  searchInput.placeholder = repo ? `Search ${repo.title}…` : "Search…";
  if (search.query && id !== search.repo) runSearch();
}

const doSearch = debounce(async (seq: number, query: string, repoId: string) => {
  let hits: SearchHit[] = [];
  let error: string | null = null;
  try {
    hits = await api.search(repoId, query);
  } catch (err) {
    error = errorMessage(err);
  }
  if (seq !== search.seq) return;
  search.hits = hits;
  search.error = error;
  renderTree();
}, 250);

function runSearch() {
  search.query = searchInput.value.trim();
  search.seq++;
  search.repo = searchRepoId();
  search.hits = null;
  search.error = null;
  if (search.query && search.repo) doSearch(search.seq, search.query, search.repo);
  renderTree();
}

function renderSearchResults() {
  const repoId = search.repo;
  const repo = repoById(repoId);
  const head = h("div", { class: "search-head" },
    h("span", null, repo ? `In ${repo.title}` : "Search"),
    h("button", { type: "button", class: "link-btn", onclick: () => ((searchInput.value = ""), runSearch()) }, "Clear"),
  );
  if (!repoId) return clear(treeEl, head, h("div", { class: "tree-note" }, "No repo selected."));
  if (search.hits === null) return clear(treeEl, head, h("div", { class: "tree-note" }, "Searching…"));
  if (search.error) return clear(treeEl, head, h("div", { class: "tree-note error" }, search.error));
  if (!search.hits.length) return clear(treeEl, head, h("div", { class: "tree-note" }, "No matches."));
  clear(treeEl, head, h("ul", null, search.hits.map((r) =>
    h("li", null, h("a", { class: "search-hit", href: urlFor(repoId, r.path), onclick: (e: MouseEvent) => (e.preventDefault(), navigate(repoId, r.path)) },
      h("span", { class: "hit-path" }, r.path, h("span", { class: "hit-line" }, `:${r.line}`)),
      h("span", { class: "hit-text" }, highlight(r.text.trim(), search.query)),
    )),
  )));
}

function highlight(text: string, query: string): (string | HTMLElement)[] {
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0 || !query) return [text];
  return [text.slice(0, i), h("mark", null, text.slice(i, i + query.length)), text.slice(i + query.length)];
}

// ---------- actions ----------

function writableRepoFor(id: string | null | undefined): Repo | undefined {
  const r = repoById(id ?? null);
  if (r && r.access === "write" && !r.readOnly) return r;
  return repos.find((x) => x.kind === "notes" && x.access === "write") ?? repos.find((x) => x.access === "write" && !x.readOnly);
}

async function newNote(repoId?: string) {
  const repo = writableRepoFor(repoId ?? current?.repo ?? selectedRepo);
  if (!repo) return toast("No writable notebook. Create one first.", "error");
  const dir = current && current.repo === repo.id && current.path.includes("/") ? current.path.slice(0, current.path.lastIndexOf("/") + 1) : "";
  const path = await promptDialog({ title: `New note in ${repo.title}`, label: "Path", value: `${dir}Untitled.md`, submit: "Create", hint: "Use slashes for folders, e.g. projects/ideas.md" });
  if (!path) return;
  try {
    const res = await api.createFile(repo.id, path);
    expandedRepos.add(repo.id);
    await loadTree(repo.id, false);
    navigate(repo.id, res.path);
  } catch (err) {
    toast(err instanceof ApiError && err.status === 409 ? `“${path}” already exists.` : errorMessage(err), "error");
  }
}

async function newNotebook() {
  const title = await promptDialog({ title: "New notebook", label: "Name", value: "", submit: "Create" });
  if (!title) return;
  try {
    const repo = await api.createNotebook(title);
    expandedRepos.add(repo.id);
    selectedRepo = repo.id;
    await loadRepos();
    toast(`Created “${repo.title}”`);
  } catch (err) {
    toast(errorMessage(err), "error");
  }
}

async function linkRepo() {
  const id = await linkGitHubDialog(config);
  if (!id) return;
  expandedRepos.add(id);
  selectedRepo = id;
  await loadRepos();
}

// For the open file, the server closes its room ("removed" / "renamed" / "deleted") and Session.onClosed navigates.

async function removeRepo(repo: Repo) {
  const ok = await confirmDialog({ title: "Remove repo", message: `Remove “${repo.title}” from Notepad?`, confirm: "Remove", danger: true });
  if (!ok) return;
  try {
    await api.deleteRepo(repo.id);
    await loadRepos();
  } catch (err) {
    toast(errorMessage(err), "error");
  }
}

async function renameFile(repo: Repo, path: string) {
  const to = await promptDialog({ title: "Rename note", label: "New path", value: path, submit: "Rename" });
  if (!to || to === path) return;
  try {
    await api.rename(repo.id, path, to);
    await loadTree(repo.id);
  } catch (err) {
    toast(errorMessage(err), "error");
  }
}

async function deleteFile(repo: Repo, path: string) {
  const ok = await confirmDialog({ title: "Delete note", message: `Delete “${path}”? It stays in the Git history.`, confirm: "Delete", danger: true });
  if (!ok) return;
  try {
    await api.deleteFile(repo.id, path);
    await loadTree(repo.id);
  } catch (err) {
    toast(errorMessage(err), "error");
  }
}

// ---------- menu ----------

type MenuItem = { label: string; run: () => void; danger?: boolean } | null;

function showMenuBelow(anchor: HTMLElement, items: MenuItem[]) {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, items, anchor);
}

function showMenu(x: number, y: number, items: MenuItem[], opener?: HTMLElement) {
  closeMenu(false);
  const list = items.filter((i): i is NonNullable<MenuItem> => !!i);
  if (!list.length) return;
  menuOpener = opener ?? (document.activeElement as HTMLElement | null);
  const buttons = list.map((i) =>
    h("button", { type: "button", class: `menu-item${i.danger ? " danger" : ""}`, role: "menuitem", tabindex: "-1", onclick: (e: MouseEvent) => (e.stopPropagation(), closeMenu(false), i.run()) }, i.label),
  );
  const menu = h("div", { class: "menu", role: "menu" }, buttons);
  menu.addEventListener("keydown", (e) => {
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = (idx + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]!.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      buttons[e.key === "Home" ? 0 : buttons.length - 1]!.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    } else if (e.key === "Tab") {
      closeMenu();
    }
  });
  menuEl = menu;
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  buttons[0]!.focus();
}

function closeMenu(restoreFocus = true) {
  if (!menuEl) return;
  const hadFocus = menuEl.contains(document.activeElement);
  menuEl.remove();
  menuEl = null;
  if (restoreFocus && hadFocus && menuOpener?.isConnected) menuOpener.focus();
  menuOpener = null;
}

// ---------- routing ----------

function urlFor(repo: string, path?: string) {
  return `/r/${encodeURIComponent(repo)}` + (path ? "/" + path.split("/").map(encodeURIComponent).join("/") : "");
}

function parseRoute(): { repo: string; path: string | null } | null {
  const m = location.pathname.match(/^\/r\/([^/]+)(?:\/(.*))?$/);
  if (!m) return null;
  try {
    const repo = decodeURIComponent(m[1]!);
    let path = m[2] ? m[2].split("/").filter((s) => s && s !== "." && s !== "..").map(decodeURIComponent).join("/") : "";
    if (path && !MD_EXT.test(path)) path += ".md";
    return { repo, path: path || null };
  } catch {
    return null;
  }
}

function navigate(repo: string, path: string, replace = false) {
  const url = urlFor(repo, path);
  if (location.pathname !== url) {
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  }
  void route();
}

function goHome(replace = false) {
  if (replace) window.history.replaceState(null, "", "/");
  else window.history.pushState(null, "", "/");
  void route();
}

async function route() {
  const seq = ++routeSeq;
  setSidebarOpen(false);
  const r = parseRoute();
  if (r?.path) {
    const canonical = urlFor(r.repo, r.path);
    if (location.pathname !== canonical) window.history.replaceState(null, "", canonical);
    return openFile(r.repo, r.path);
  }
  const repoId = r?.repo ?? repos.find((x) => x.kind === "notes")?.id ?? repos[0]?.id;
  if (!repoId) return showEmpty();
  const target = await defaultFile(repoId);
  if (seq !== routeSeq) return;
  if (target) {
    window.history.replaceState(null, "", urlFor(repoId, target));
    return openFile(repoId, target);
  }
  selectedRepo = repoId;
  expandedRepos.add(repoId);
  showEmpty();
}

async function defaultFile(repoId: string): Promise<string | null> {
  if (!trees.has(repoId) || "error" in trees.get(repoId)!) await loadTree(repoId, false);
  const tree = trees.get(repoId);
  if (!tree || "error" in tree || !tree.files.length) return null;
  return tree.files.find((f) => f === "Welcome.md") ?? tree.files.find((f) => /^readme\.md$/i.test(f)) ?? tree.files[0]!;
}

// ---------- document ----------

function openFile(repo: string, path: string) {
  if (session && session.repo === repo && session.path === path && !session.ended) return;
  closeSession();
  current = { repo, path };
  selectedRepo = repo;
  if (!expandedRepos.has(repo)) {
    expandedRepos.add(repo);
    if (!trees.has(repo)) void loadTree(repo);
  }
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) collapsedFolders.delete(fkey(repo, parts.slice(0, i).join("/")));
  document.title = `${displayName(path)} · Notepad`;
  updateSearchRepo();
  renderTree();
  session = new Session(repo, path);
  history.setTarget({ repo, path, readOnly: isRepoReadOnly(repo) });
  renderHeader();
}

function isRepoReadOnly(repoId: string) {
  const r = repoById(repoId);
  return !r || r.readOnly || r.access !== "write";
}

function closeSession() {
  const s = session;
  session = null;
  s?.destroy();
}

function showEmpty() {
  closeSession();
  current = null;
  document.title = "Notepad";
  history.setTarget(null);
  renderHeader();
  updateSearchRepo();
  renderTree();
  const repo = writableRepoFor(selectedRepo);
  clear(docBody, h("div", { class: "empty-state" },
    h("div", { class: "empty-icon" }, "✎"),
    h("h2", null, repos.length ? "No note open" : "Welcome to Notepad"),
    h("p", { class: "muted" }, repos.length ? "Pick a note from the sidebar, or start a new one." : "Create a notebook to get started."),
    repos.length
      ? repo ? h("button", { type: "button", class: "btn btn-primary", onclick: () => void newNote(repo.id) }, "New note") : null
      : h("button", { type: "button", class: "btn btn-primary", onclick: newNotebook }, "New notebook"),
  ));
}

function renderHeader() {
  historyBtn.disabled = !session;
  if (!session && history.open) history.close();
  if (!current) {
    clear(breadcrumbEl);
    clear(participantsEl);
    clear(saveStatusEl);
    return;
  }
  const { repo: repoId } = current;
  const repo = repoById(repoId);
  const parts = current.path.split("/");
  clear(breadcrumbEl,
    h("button", { type: "button", class: "crumb crumb-repo", onclick: () => ((selectedRepo = repoId), expandedRepos.add(repoId), renderTree()) }, repo?.title ?? repoId),
    parts.slice(0, -1).flatMap((p) => [h("span", { class: "crumb-sep" }, "/"), h("span", { class: "crumb" }, p)]),
    h("span", { class: "crumb-sep" }, "/"),
    h("span", { class: "crumb crumb-file" }, basename(current.path)),
  );
  renderParticipants();
  renderSaveStatus();
}

function renderParticipants() {
  if (!session) return clear(participantsEl);
  const seen = new Map<string, PresenceState["user"] & { self?: boolean }>();
  seen.set(me.id, { ...session.localUser, self: true });
  for (const [clientId, state] of session.provider.awareness.getStates()) {
    if (clientId === session.doc.clientID) continue;
    const u = validPeerUser((state as { user?: unknown } | null)?.user);
    if (u && !seen.has(u.id)) seen.set(u.id, u);
  }
  const users = [...seen.values()];
  clear(participantsEl, users.slice(0, 6).map((u) => {
    const el = avatar(u);
    if (u.self) el.title = `${u.name} (you)`;
    return el;
  }), users.length > 6 ? h("span", { class: "avatar avatar-more" }, `+${users.length - 6}`) : null);
}

function renderSaveStatus() {
  if (!session) return clear(saveStatusEl);
  const p = session.provider;
  const s = p.saveState;
  let text: string;
  let cls = "";
  if (p.status !== "connected") {
    if (session.everConnected) {
      text = session.readOnly ? "Offline" : "Offline — changes will sync when reconnected";
      cls = "warn";
    } else text = "Connecting…";
  } else if (session.readOnly) {
    text = "Read-only";
  } else if (s.saving) {
    text = "Saving…";
  } else if (s.dirty) {
    text = "Unsaved changes";
    cls = "dirty";
  } else if (s.commit) {
    const when = relativeTime(s.savedAt);
    text = `Saved · ${shortSha(s.commit)}${when ? ` · ${when}` : ""}`;
  } else {
    text = "Not saved yet";
  }
  saveStatusEl.className = `save-status ${cls}`;
  saveStatusEl.textContent = text;
  saveStatusEl.title = session.readOnly ? "" : `${isMac ? "⌘" : "Ctrl"}-S to save now`;
}

/** Whether mounting the editor may take focus: not while the user is typing elsewhere or in a dialog. */
function mayFocusEditor() {
  if (document.querySelector("dialog[open]") || menuEl) return false;
  const a = document.activeElement;
  return !a || a === document.body || docBody.contains(a);
}

class Session {
  readonly doc = new Y.Doc();
  readonly provider: NotepadProvider;
  readonly localUser: PresenceState["user"];
  readonly host = h("div", { class: "editor-host" });
  private editor: { destroy(): void; focus(): void } | null = null;
  everConnected = false;
  ended = false;

  constructor(
    readonly repo: string,
    readonly path: string,
  ) {
    this.localUser = { id: me.id, name: me.name, color: me.color ?? colorFor(me.id), kind: "human", ...(me.avatar ? { avatar: me.avatar } : {}) };
    this.provider = new NotepadProvider(this.doc, repo, path);
    this.provider.awareness.setLocalState({ user: this.localUser, cursor: null } satisfies PresenceState);
    clear(docBody, h("div", { class: "loading" }, h("span", { class: "spinner" }), "Loading…"));

    const p = this.provider;
    p.on("synced", () => this.mount());
    p.on("readOnly", () => {
      if (this.editor) this.mount();
      history.setTarget({ repo, path, readOnly: this.readOnly });
      renderSaveStatus();
    });
    p.on("status", (s) => {
      if (s === "connected") this.everConnected = true;
      renderSaveStatus();
    });
    p.on("saveState", () => renderSaveStatus());
    p.awareness.on("change", () => renderParticipants());
    p.on("reset", () => {
      if (session !== this) return;
      toast("This note was reloaded from the server.");
      closeSession();
      openFile(repo, path);
    });
    p.on("closed", (reason, to) => this.onClosed(reason, to));
  }

  get readOnly() {
    return this.provider.readOnly;
  }

  flush() {
    if (this.readOnly || this.ended) return;
    this.provider.flush();
    if (this.provider.status !== "connected") toast("Offline — will save when reconnected.");
  }

  private mount() {
    if (this.ended) return;
    const focus = !this.editor && mayFocusEditor();
    this.editor?.destroy();
    this.editor = null;
    this.host.replaceChildren();
    clear(docBody, this.host);
    this.editor = mountEditor(this.host, { ytext: this.doc.getText("md"), awareness: this.provider.awareness, readOnly: this.readOnly });
    if (focus) this.editor.focus();
    renderSaveStatus();
  }

  private onClosed(reason: ClosedReason, to: string | undefined) {
    if (session !== this) return;
    const name = displayName(this.path);
    switch (reason) {
      case "renamed":
        if (to) {
          toast(`“${name}” was renamed to “${displayName(to)}”.`);
          closeSession();
          void loadTree(this.repo);
          return navigate(this.repo, to, true);
        }
        toast(`“${name}” was renamed.`);
        return this.leave();
      case "deleted":
        toast(`“${name}” was deleted.`);
        return this.leave();
      case "removed":
        toast("This repo was removed.");
        return this.leave();
      case "unauthorized":
        location.reload();
        return;
      case "forbidden":
        return this.notice("No access", "You don't have access to this note.");
      case "notfound": {
        const repo = repoById(this.repo);
        const canCreate = repo && repo.access === "write" && !repo.readOnly;
        const { repo: repoId, path } = this;
        return this.notice("Note not found", `“${path}” doesn't exist${repo ? ` in ${repo.title}` : ""}.`,
          canCreate ? h("button", { type: "button", class: "btn btn-primary", onclick: async () => {
            try {
              await api.createFile(repoId, path);
              void loadTree(repoId);
              openFile(repoId, path);
            } catch (err) {
              toast(errorMessage(err), "error");
            }
          } }, "Create it") : null);
      }
      default:
        return this.notice("Closed", `The note was closed (${reason}).`);
    }
  }

  private leave() {
    closeSession();
    void loadTree(this.repo);
    goHome(true);
  }

  /** Replace the editor with a message; the connection is gone for good. */
  private notice(title: string, message: string, action?: HTMLElement | null) {
    closeSession();
    history.setTarget(null);
    renderHeader();
    clear(docBody, h("div", { class: "empty-state" },
      h("h2", null, title),
      h("p", { class: "muted" }, message),
      h("div", { class: "row" }, action ?? null, h("button", { type: "button", class: "btn", onclick: () => goHome() }, "Go home")),
    ));
  }

  destroy() {
    if (this.ended) return;
    this.ended = true;
    this.editor?.destroy();
    this.editor = null;
    this.provider.destroy();
    this.doc.destroy();
  }
}
