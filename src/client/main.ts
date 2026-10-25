// App shell: sidebar (repos, file tree, filter, search), document header, editor session, history, routing.
import * as Y from "yjs";
import { mountEditor } from "./editor/index.ts";
import { api, ApiError, subscribeEvents, type AppEvent, type Config, type Me, type PresenceUserInfo, type Repo, type SearchHit, type Tree } from "./api.ts";
import { GrimoireProvider, type ClosedReason } from "./provider.ts";
import { HistoryPanel } from "./history.ts";
import { renderHome, renderStart } from "./home.ts";
import { addGitHubDialog, agentTokensDialog, confirmDialog, promptDialog } from "./dialogs.ts";
import { githubFileUrl } from "../shared/github.ts";
import { avatar, clear, colorFor, debounce, displayName, errorMessage, h, pickNote, relativeTime, shortSha, toast, validPeerUser } from "./util.ts";
import type { PresenceState } from "../shared/presence.ts";

// ---------- state ----------

let config: Config;
let me: Me;
let repos: Repo[] = [];
const trees = new Map<string, Tree | { error: string }>();
/** Folder tree per repo, built once when its file list loads. */
const folderCache = new Map<string, Folder>();
/** Repos and folders the user opened or closed, keyed like tree rows ("repo:<id>", "dir:<repo>\0<path>"). Others use their default. */
const openState = new Map<string, boolean>();
const presence = new Map<string, PresenceUserInfo[]>();
let current: { repo: string; path: string } | null = null;
let selectedRepo: string | null = null;
let session: Session | null = null;
let routeSeq = 0;
/** The tree row that takes Tab focus (roving tabindex). */
let treeFocusKey: string | null = null;
let treeFrame = 0;
const search = {
  query: "",
  seq: 0,
  /** The repo the results (or the pending request) belong to. */
  repo: null as string | null,
  hits: null as SearchHit[] | null,
  error: null as string | null,
  /** Why the results may be missing matches. */
  incomplete: null as string | null,
};

const fkey = (repo: string, path: string) => `${repo}\u0000${path}`;
const repoKey = (id: string) => `repo:${id}`;
const dirKey = (repo: string, path: string) => `dir:${fkey(repo, path)}`;
const repoById = (id: string | null) => (id ? repos.find((r) => r.id === id) : undefined);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MD_EXT = /\.(md|markdown|mdx)$/i;
const TREE_STATE_KEY = "grimoire.tree.v2";
/** While filtering, each repo renders at most this many matching files. */
const FILTER_LIMIT = 100;

// ---------- elements ----------

const app = document.getElementById("app")!;
const treeEl = h("nav", { class: "sb-tree", "aria-label": "Files" });
const filterInput = h("input", { type: "search", class: "sb-filter-input", placeholder: "Filter files", autocomplete: "off", spellcheck: "false", "aria-label": "Filter files", "aria-keyshortcuts": "/" });
const breadcrumbEl = h("div", { class: "breadcrumb" });
const sourceEl = h("div", { class: "doc-source" });
const participantsEl = h("div", { class: "participants" });
const saveStatusEl = h("div", { class: "save-status", "aria-live": "polite" });
const historyBtn = h("button", { type: "button", class: "btn btn-tab", disabled: true, "aria-pressed": "false" }, "History");
const docBody = h("div", { class: "doc-body" });
const history = new HistoryPanel((open) => {
  historyBtn.classList.toggle("active", open);
  historyBtn.setAttribute("aria-pressed", String(open));
  app.classList.toggle("history-open", open);
});
let menuEl: HTMLElement | null = null;
let menuOpener: HTMLElement | null = null;
let menuOpenerKey: string | null = null;

// ---------- boot ----------

void boot();

async function boot() {
  try {
    config = await api.config();
  } catch (err) {
    clear(app, h("div", { class: "fatal" }, "Couldn't reach the server: ", errorMessage(err)));
    return;
  }
  const onStart = location.pathname === "/start";
  try {
    me = await api.me();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return onStart ? renderStart(app, config, false) : renderHome(app, config);
    clear(app, h("div", { class: "fatal" }, errorMessage(err)));
    return;
  }
  if (onStart) return renderStart(app, config, true);
  loadTreeState();
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

// ---------- shell ----------

function renderShell() {
  app.className = "app";
  const userBtn = h("button", { type: "button", class: "user-btn", title: `${me.name} — menu`, "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": `${me.name}, account and notebooks menu` },
    avatar({ id: me.id, name: me.name, color: me.color, avatar: me.avatar }),
    h("span", { class: "user-name" }, me.name),
    h("span", { class: "chev chev-down", "aria-hidden": "true" }),
  );
  userBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showMenu(userBtn, [
      { label: "New notebook…", run: newNotebook },
      { label: "Add GitHub repo…", run: addGitHubRepo },
      me.isAdmin ? { label: "Agent tokens…", run: () => agentTokensDialog() } : null,
      { label: "Sign out", run: logout },
    ], { alignRight: true });
  });

  filterInput.addEventListener("input", onFilterInput);
  filterInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (filterInput.value) {
        e.preventDefault();
        filterInput.value = "";
        onFilterInput();
      } else filterInput.blur();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(visibleRows()[0]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      flushTree();
      const first = treeEl.querySelector<HTMLElement>(".file-row");
      if (!first) return;
      // Leave the input so the opened note takes focus.
      filterInput.blur();
      rowActions.get(first)?.activate();
    }
  });

  historyBtn.addEventListener("click", () => history.toggle());

  treeEl.addEventListener("keydown", onTreeKey);
  treeEl.addEventListener("focusin", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[role=treeitem]");
    if (row?.dataset.key) {
      treeFocusKey = row.dataset.key;
      applyRoving();
    }
  });

  clear(app,
    h("aside", { class: "sidebar", id: "sidebar" },
      h("div", { class: "sb-head" },
        h("a", { class: "slab-blk slab-sm", href: "/", "aria-label": "Grimoire home", onclick: (e: MouseEvent) => (e.preventDefault(), goHome()) }, "GRIMOIRE"),
        userBtn,
      ),
      h("div", { class: "sb-tools" },
        h("div", { class: "sb-actions" },
          h("button", { type: "button", class: "quiet-btn new-note", onclick: () => void newNote() }, h("span", { class: "plus", "aria-hidden": "true" }, "+"), "New note"),
          h("button", { type: "button", class: "quiet-btn add-github", onclick: addGitHubRepo }, h("span", { class: "plus", "aria-hidden": "true" }, "+"), "GitHub repo"),
        ),
        h("label", { class: "sb-filter" }, filterInput, h("kbd", { "aria-hidden": "true" }, "/")),
      ),
      treeEl,
    ),
    h("div", { class: "sidebar-backdrop", onclick: () => setSidebarOpen(false) }),
    h("main", { class: "main" },
      h("header", { class: "doc-header" },
        h("button", { type: "button", class: "icon-btn sidebar-toggle", "aria-label": "Sidebar", "aria-expanded": "false", "aria-controls": "sidebar", onclick: () => setSidebarOpen(!app.classList.contains("sidebar-open")) }, h("span", { class: "burger", "aria-hidden": "true" })),
        breadcrumbEl, sourceEl, h("div", { class: "spacer" }), participantsEl, saveStatusEl, historyBtn,
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
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    if (isEditable(e.target) || document.querySelector("dialog[open]") || menuEl) return;
    e.preventDefault();
    setSidebarOpen(true);
    filterInput.focus();
    filterInput.select();
  });
  document.addEventListener("click", () => closeMenu());
  window.addEventListener("blur", () => closeMenu());
}

function isEditable(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

function setSidebarOpen(open: boolean) {
  app.classList.toggle("sidebar-open", open);
  app.querySelector(".sidebar-toggle")?.setAttribute("aria-expanded", String(open));
}

async function logout() {
  try {
    await api.logout();
  } catch {}
  location.href = "/";
}

// ---------- data ----------

/** Reload the repo list and the trees of open repos (all loaded trees when `refresh`). */
async function loadRepos(refresh = false) {
  try {
    repos = await api.repos();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return location.reload();
    toast(`Couldn't load repos: ${errorMessage(err)}`, "error");
  }
  for (const id of [...trees.keys()]) {
    if (!repoById(id)) {
      trees.delete(id);
      folderCache.delete(id);
    }
  }
  // Trees that failed to load (e.g. while the repo was importing) are retried too.
  const ids = repos.filter((r) => (refresh && trees.has(r.id)) || ((isRepoOpen(r) || filterQuery()) && r.status === "ready" && (!trees.has(r.id) || "error" in trees.get(r.id)!))).map((r) => r.id);
  await Promise.all(ids.map((id) => loadTree(id, false)));
  renderTree();
  renderHeader();
  updateSearchRepo();
}

async function loadTree(id: string, render = true) {
  try {
    const tree = await api.tree(id);
    trees.set(id, tree);
    folderCache.set(id, buildFolders(tree.files));
  } catch (err) {
    trees.set(id, { error: errorMessage(err) });
    folderCache.delete(id);
  }
  if (render) renderTree();
}

/** Ids of the people (not me) in a file, for telling whether its presence dots changed. */
function peerSignature(users: PresenceUserInfo[] | undefined) {
  return (users ?? []).filter((u) => u.id !== me.id).map((u) => `${u.id}:${u.color}:${u.kind}`).sort().join(",");
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
      const before = peerSignature(presence.get(key));
      if (users.length) presence.set(key, users);
      else presence.delete(key);
      if (peerSignature(users) !== before) renderTree();
      break;
    }
    case "saved":
      history.onSaved(e.repo, e.path);
      break;
  }
}

// ---------- open/closed state (localStorage) ----------

function loadTreeState() {
  try {
    const raw = JSON.parse(localStorage.getItem(TREE_STATE_KEY) ?? "null") as { user?: string; open?: unknown } | null;
    if (!raw || raw.user !== me.id || !raw.open || typeof raw.open !== "object") return;
    for (const [k, v] of Object.entries(raw.open)) if (typeof v === "boolean") openState.set(k, v);
  } catch {}
}

function saveTreeState() {
  try {
    // Keep the newest 500 entries so the stored state can't grow without bound.
    localStorage.setItem(TREE_STATE_KEY, JSON.stringify({ user: me.id, open: Object.fromEntries([...openState].slice(-500)) }));
  } catch {}
}

/** Notebooks start open with their folders open; linked repos (often big) start closed. */
function openByDefault(repoId: string) {
  return repoById(repoId)?.kind === "notes";
}

function isOpen(key: string, repoId: string) {
  return openState.get(key) ?? openByDefault(repoId);
}

function setOpenState(key: string, repoId: string, open: boolean) {
  openState.delete(key);
  if (open !== openByDefault(repoId)) openState.set(key, open);
  saveTreeState();
}

const isRepoOpen = (r: Repo) => isOpen(repoKey(r.id), r.id);
const setRepoOpen = (id: string, open: boolean) => setOpenState(repoKey(id), id, open);

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

interface RowActions {
  activate: () => void;
  /** Containers only: open or close. */
  setOpen?: (open: boolean) => void;
  menu: () => MenuItem[];
}
const rowActions = new WeakMap<HTMLElement, RowActions>();
let groupSeq = 0;

function filterQuery() {
  return filterInput.value.trim().toLowerCase();
}

/** Every space-separated term must be in the path, or (loosely) in order in the file name. */
function matchesFilter(path: string, q: string) {
  const p = path.toLowerCase().replace(MD_EXT, "");
  const name = p.slice(p.lastIndexOf("/") + 1);
  return q.split(/\s+/).filter(Boolean).every((t) => p.includes(t) || (t.length > 1 && isSubsequence(t, name)));
}

function isSubsequence(needle: string, hay: string) {
  let i = 0;
  for (const c of hay) if (c === needle[i] && ++i === needle.length) return true;
  return false;
}

function onFilterInput() {
  const q = filterQuery();
  treeFocusKey = null;
  // Filtering covers every repo, so load the trees nobody has opened yet.
  if (q) for (const r of repos) if (!trees.has(r.id) && r.status === "ready") void loadTree(r.id);
  runSearch();
}

/** Schedule a tree render; several changes in one frame render once. */
function renderTree() {
  if (!treeFrame) treeFrame = requestAnimationFrame(renderTreeNow);
}

/** Render a pending tree update right away (before reading the rows). */
function flushTree() {
  if (!treeFrame) return;
  cancelAnimationFrame(treeFrame);
  renderTreeNow();
}

function renderTreeNow() {
  treeFrame = 0;
  const scroll = treeEl.scrollTop;
  // Re-rendering replaces the rows; keep keyboard focus on the same row or search hit.
  const active = document.activeElement as HTMLElement | null;
  const focusKey = treeEl.contains(active) ? active?.closest<HTMLElement>("[data-key]")?.dataset.key : undefined;
  const q = filterQuery();
  groupSeq = 0;
  if (!repos.length) {
    clear(treeEl, h("div", { class: "sb-empty" }, h("p", null, "No notebooks yet."), h("button", { class: "btn", type: "button", onclick: newNotebook }, "Create a notebook")));
  } else {
    const items = repos.map((r) => renderRepo(r, q)).filter((x) => x !== null);
    clear(treeEl,
      items.length
        ? h("ul", { role: "tree", class: "tree", "aria-label": q ? "Matching files" : "Files" }, items)
        : h("p", { class: "tree-note" }, q ? "No file names match." : "No notes yet."),
      q ? renderSearchResults() : null,
    );
  }
  applyRoving();
  treeEl.scrollTop = scroll;
  if (focusKey && (document.activeElement === document.body || !document.activeElement)) {
    treeEl.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
  }
}

function visibleRows(): HTMLElement[] {
  return [...treeEl.querySelectorAll<HTMLElement>("[role=treeitem]")];
}

function applyRoving() {
  const rows = visibleRows();
  const target =
    rows.find((r) => r.dataset.key === treeFocusKey) ??
    rows.find((r) => r.getAttribute("aria-current") === "page") ??
    rows[0];
  for (const r of rows) r.tabIndex = r === target ? 0 : -1;
}

function focusRow(row: HTMLElement | undefined) {
  if (!row) return;
  treeFocusKey = row.dataset.key ?? null;
  applyRoving();
  row.focus();
  row.scrollIntoView({ block: "nearest" });
}

function parentRow(row: HTMLElement): HTMLElement | undefined {
  const li = row.closest("li")?.parentElement?.closest("li");
  return li?.querySelector<HTMLElement>("[role=treeitem]") ?? undefined;
}

function onTreeKey(e: KeyboardEvent) {
  const row = e.target as HTMLElement;
  if (row.getAttribute?.("role") !== "treeitem" || e.altKey || e.metaKey || e.ctrlKey) return;
  const acts = rowActions.get(row);
  const rows = visibleRows();
  const i = rows.indexOf(row);
  const expanded = row.getAttribute("aria-expanded");
  let handled = true;
  switch (e.key) {
    case "ArrowDown":
      focusRow(rows[i + 1]);
      break;
    case "ArrowUp":
      if (i > 0) focusRow(rows[i - 1]);
      else filterInput.focus();
      break;
    case "Home":
      focusRow(rows[0]);
      break;
    case "End":
      focusRow(rows[rows.length - 1]);
      break;
    case "ArrowRight":
      if (expanded === "false") acts?.setOpen?.(true);
      else if (expanded === "true" && rows[i + 1] && parentRow(rows[i + 1]!) === row) focusRow(rows[i + 1]);
      break;
    case "ArrowLeft":
      if (expanded === "true" && !filterQuery()) acts?.setOpen?.(false);
      else focusRow(parentRow(row));
      break;
    case "Enter":
    case " ":
      acts?.activate();
      break;
    case "F10":
      if (!e.shiftKey) return;
      showMenu(row, acts?.menu() ?? []);
      break;
    case "ContextMenu":
      showMenu(row, acts?.menu() ?? []);
      break;
    default:
      handled = false;
  }
  if (handled) e.preventDefault();
}

function bindRow(el: HTMLElement, acts: RowActions) {
  rowActions.set(el, acts);
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showMenu({ x: e.clientX, y: e.clientY }, acts.menu(), { opener: el });
  });
}

function chevron() {
  return h("span", { class: "chev", "aria-hidden": "true" });
}

/** A row's "⋯" button. It sits next to the row (not inside it) so the row stays a single focusable item. */
function menuButton(rowKey: string, label: string, items: () => MenuItem[]) {
  return h("button", {
    type: "button", class: "icon-btn row-menu", tabindex: "-1", title: "More", "aria-label": label, "aria-haspopup": "menu", "aria-expanded": "false", "data-for": rowKey,
    onclick: (e: MouseEvent) => (e.preventDefault(), e.stopPropagation(), showMenu(e.currentTarget as HTMLElement, items())),
  }, "⋯");
}

/** A child group, owned by its row for assistive tech. */
function group(row: HTMLElement, ul: HTMLElement) {
  ul.id = `tg-${++groupSeq}`;
  row.setAttribute("aria-owns", ul.id);
  return ul;
}

function renderRepo(repo: Repo, q: string): HTMLElement | null {
  const tree = trees.get(repo.id);
  const loaded = tree && !("error" in tree) ? tree : null;
  // Filtering shows matches only: repos that are importing or failed have none to show.
  if (q && (repo.status === "importing" || repo.status === "error" || (tree && !loaded))) return null;
  const matches = q && loaded ? loaded.files.filter((f) => matchesFilter(f, q)) : null;
  if (matches && !matches.length) return null;
  const open = q ? true : isRepoOpen(repo);
  const writable = repo.access === "write" && !repo.readOnly;
  const key = repoKey(repo.id);
  const setOpen = (next: boolean) => {
    // While filtering every repo is shown open; the saved state stays as it was.
    if (q) return;
    selectedRepo = repo.id;
    updateSearchRepo();
    setRepoOpen(repo.id, next);
    renderTree();
    if (next && !trees.has(repo.id)) void loadTree(repo.id);
  };
  const menuItems = (): MenuItem[] => [
    writable ? { label: "New note here…", run: () => void newNote(repo.id) } : null,
    repo.kind === "github" && repo.ghOwner ? { label: "Open on GitHub", run: () => window.open(`https://github.com/${repo.ghOwner}/${repo.ghName}`, "_blank", "noopener") } : null,
    { label: "Refresh", run: () => void refreshRepo(repo) },
    repo.canRemove ? { label: "Remove…", danger: true, run: () => void removeRepo(repo) } : null,
  ];
  const readOnly = repo.readOnly || repo.access === "read";
  const row = h("div", {
    class: `repo-row${selectedRepo === repo.id ? " selected" : ""}`,
    role: "treeitem", tabindex: "-1", "aria-level": "1", "aria-expanded": String(open), "data-key": key,
    title: repo.error ?? (repo.kind === "github" && repo.ghOwner ? `${repo.ghOwner}/${repo.ghName}` : repo.title),
    onclick: () => setOpen(!open),
  },
    chevron(),
    h("span", { class: "repo-title" }, repo.title),
    repo.status === "importing" ? h("span", { class: "badge" }, "Importing") : null,
    repo.status === "error" ? h("span", { class: "badge badge-error", title: repo.error ?? "" }, "Error") : null,
    readOnly ? h("span", { class: "badge" }, "Read-only") : null,
  );
  bindRow(row, { activate: () => setOpen(!open), setOpen, menu: menuItems });
  const actions = h("span", { class: "row-actions" },
    writable
      ? h("button", { type: "button", class: "icon-btn", tabindex: "-1", title: "New note", "aria-label": `New note in ${repo.title}`, onclick: (e: MouseEvent) => (e.stopPropagation(), void newNote(repo.id)) }, "+")
      : null,
    menuButton(key, `${repo.title} actions`, menuItems),
  );

  let children: HTMLElement | null = null;
  if (open) {
    if (!tree) children = h("div", { class: "tree-note" }, repo.status === "importing" ? "Importing…" : "Loading…");
    else if (!loaded) children = h("div", { class: "tree-note error" }, repo.status === "importing" ? "Importing…" : (tree as { error: string }).error);
    else if (!loaded.files.length) children = h("div", { class: "tree-note" }, repo.status === "importing" ? "Importing…" : "No notes yet.");
    else if (matches) {
      const shown = matches.slice(0, FILTER_LIMIT);
      children = h("div", null,
        group(row, renderFolder(repo, buildFolders(shown), 2, q)),
        matches.length > shown.length ? h("p", { class: "tree-note" }, `Showing ${shown.length} of ${matches.length}. Type more to narrow it down.`) : null,
      );
    } else children = group(row, renderFolder(repo, folderCache.get(repo.id) ?? buildFolders(loaded.files), 2, q));
  }
  return h("li", { class: "repo", role: "none" }, h("div", { class: "row-wrap" }, row, actions), children);
}

function renderFolder(repo: Repo, folder: Folder, level: number, q: string): HTMLElement {
  const ul = h("ul", { role: "group" });
  const folders = [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const f of folders) {
    const key = dirKey(repo.id, f.path);
    const open = q ? true : isOpen(key, repo.id);
    const setOpen = (next: boolean) => {
      if (q) return;
      setOpenState(key, repo.id, next);
      renderTree();
    };
    const row = h("div", {
      class: "folder-row", role: "treeitem", tabindex: "-1", "aria-level": String(level), "aria-expanded": String(open),
      "data-key": key, title: f.path, style: { "--depth": String(level - 1) },
      onclick: () => setOpen(!open),
    },
      chevron(),
      h("span", { class: "folder-name" }, f.name),
    );
    bindRow(row, { activate: () => setOpen(!open), setOpen, menu: () => [] });
    ul.appendChild(h("li", { role: "none" }, row, open ? group(row, renderFolder(repo, f, level + 1, q)) : null));
  }
  for (const path of folder.files) ul.appendChild(renderFile(repo, path, level, q));
  return ul;
}

function renderFile(repo: Repo, path: string, level: number, q: string) {
  const active = current?.repo === repo.id && current.path === path;
  const users = (presence.get(fkey(repo.id, path)) ?? []).filter((u) => u.id !== me.id);
  const writable = repo.access === "write" && !repo.readOnly;
  const items = (): MenuItem[] => [
    { label: "Open", run: () => navigate(repo.id, path) },
    writable ? { label: "Rename…", run: () => void renameFile(repo, path) } : null,
    writable ? { label: "Delete…", danger: true, run: () => void deleteFile(repo, path) } : null,
  ];
  const name = displayName(path);
  const key = `file:${fkey(repo.id, path)}`;
  const term = q.split(/\s+/).find((t) => t && name.toLowerCase().includes(t));
  const a = h("a", {
    class: `file-row${active ? " active" : ""}`, href: urlFor(repo.id, path), role: "treeitem", tabindex: "-1", "aria-level": String(level),
    "aria-current": active ? "page" : undefined, "aria-selected": active ? "true" : "false",
    "data-key": key, style: { "--depth": String(level - 1) }, title: path,
  },
    h("span", { class: "file-name" }, term ? highlight(name, term) : name),
    users.length
      ? h("span", { class: "presence-dots", role: "img", "aria-label": `${users.map((u) => u.name).join(", ")} here`, title: users.map((u) => u.name).join(", ") },
          users.slice(0, 4).map((u) => h("span", { class: `pdot${u.kind === "agent" ? " is-agent" : ""}`, style: { "--c": u.color } })),
          users.length > 4 ? h("span", { class: "more" }, `+${users.length - 4}`) : null)
      : null,
  );
  a.addEventListener("click", (e) => {
    // Modified and middle clicks keep the browser's open-in-new-tab behavior.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    // A mouse click hands focus to the editor; keyboard activation keeps it in the tree.
    if (e.detail > 0) a.blur();
    navigate(repo.id, path);
  });
  bindRow(a, { activate: () => navigate(repo.id, path), menu: items });
  return h("li", { role: "none", class: `file-item${active ? " active" : ""}` }, a, menuButton(key, `${name} actions`, items));
}

// ---------- search (note contents, shown under the filtered tree) ----------

function searchRepoId() {
  return current?.repo ?? selectedRepo ?? repos[0]?.id ?? null;
}

/** Re-run the search if the repo it applies to changed. */
function updateSearchRepo() {
  const id = searchRepoId();
  if (search.query && id !== search.repo) runSearch();
}

const doSearch = debounce(async (seq: number, query: string, repoId: string) => {
  let hits: SearchHit[] = [];
  let error: string | null = null;
  let incomplete: string | null = null;
  try {
    const r = await api.search(repoId, query);
    hits = r.hits;
    incomplete = r.incomplete ?? null;
  } catch (err) {
    error = errorMessage(err);
  }
  if (seq !== search.seq) return;
  search.hits = hits;
  search.error = error;
  search.incomplete = incomplete;
  renderTree();
}, 250);

function runSearch() {
  search.query = filterInput.value.trim();
  search.seq++;
  search.repo = searchRepoId();
  search.hits = null;
  search.error = null;
  search.incomplete = null;
  if (search.query && search.repo) doSearch(search.seq, search.query, search.repo);
  renderTree();
}

function renderSearchResults(): HTMLElement {
  const repoId = search.repo;
  const repo = repoById(repoId);
  const head = h("div", { class: "sb-label" }, h("span", null, repo ? `In text · ${repo.title}` : "In text"));
  const note = search.incomplete ? h("div", { class: "tree-note" }, search.incomplete) : null;
  const wrap = (...body: (HTMLElement | null)[]) => h("section", { class: "sb-hits", "aria-label": "Text matches" }, head, ...body, note);
  if (!repoId) return wrap(h("div", { class: "tree-note" }, "No repo selected."));
  if (search.hits === null) return wrap(h("div", { class: "tree-note" }, "Searching…"));
  if (search.error) return wrap(h("div", { class: "tree-note error" }, search.error));
  if (!search.hits.length) return wrap(h("div", { class: "tree-note" }, "No text matches."));
  return wrap(h("ul", null, search.hits.map((r) =>
    h("li", null, h("a", { class: "search-hit", href: urlFor(repoId, r.path), "data-key": `hit:${fkey(repoId, r.path)}:${r.line}`, onclick: (e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(repoId, r.path);
    } },
      h("span", { class: "hit-path" }, displayName(r.path), h("span", { class: "hit-line" }, ` ${r.line}`)),
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
    setRepoOpen(repo.id, true);
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
    setRepoOpen(repo.id, true);
    selectedRepo = repo.id;
    await loadRepos();
    toast(`Created “${repo.title}”`);
  } catch (err) {
    toast(errorMessage(err), "error");
  }
}

function addGitHubRepo() {
  const seq = routeSeq;
  addGitHubDialog(config, {
    added(repo) {
      setRepoOpen(repo.id, true);
      selectedRepo = repo.id;
      if (!repoById(repo.id)) repos = [...repos, repo];
      renderTree();
      void loadRepos();
    },
    async ready(repo, path, inDialog) {
      await loadRepos();
      // Imports that finish after the dialog was closed only open a note if the user hasn't gone elsewhere.
      if (!path || (!inDialog && seq !== routeSeq)) return;
      navigate(repo.id, path);
    },
  });
}

async function refreshRepo(repo: Repo) {
  try {
    await api.refresh(repo.id);
  } catch (err) {
    toast(errorMessage(err), "error");
  }
  await loadTree(repo.id);
}

// For the open file, the server closes its room ("removed" / "renamed" / "deleted") and Session.onClosed navigates.

async function removeRepo(repo: Repo) {
  const ok = await confirmDialog({ title: "Remove repo", message: `Remove “${repo.title}” from Grimoire?`, confirm: "Remove", danger: true });
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

/** Open a menu below an element (its opener), or at a point (e.g. a right-click). */
function showMenu(at: HTMLElement | { x: number; y: number }, items: MenuItem[], opts: { opener?: HTMLElement; alignRight?: boolean } = {}) {
  closeMenu(false);
  const list = items.filter((i): i is NonNullable<MenuItem> => !!i);
  if (!list.length) return;
  const anchor = at instanceof HTMLElement ? at : null;
  const opener = opts.opener ?? anchor ?? (document.activeElement as HTMLElement | null);
  menuOpener = opener;
  menuOpenerKey = opener ? opener.dataset.key ?? opener.dataset.for ?? opener.closest<HTMLElement>("[data-key]")?.dataset.key ?? null : null;
  if (opener?.hasAttribute("aria-haspopup")) opener.setAttribute("aria-expanded", "true");
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
  let x: number;
  let y: number;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    x = opts.alignRight ? r.right - rect.width : r.left;
    y = r.bottom + 2;
  } else {
    ({ x, y } = at as { x: number; y: number });
  }
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  buttons[0]!.focus();
}

function closeMenu(restoreFocus = true) {
  if (!menuEl) return;
  const hadFocus = menuEl.contains(document.activeElement);
  menuEl.remove();
  menuEl = null;
  menuOpener?.setAttribute("aria-expanded", "false");
  if (restoreFocus && hadFocus) {
    // The opener may have been replaced by a re-render: fall back to its row, then to the tree's tab stop.
    const target =
      (menuOpener?.isConnected && !menuOpener.dataset.for ? menuOpener : null) ??
      (menuOpenerKey ? document.querySelector<HTMLElement>(`[data-key="${CSS.escape(menuOpenerKey)}"]`) : null) ??
      treeEl.querySelector<HTMLElement>("[role=treeitem][tabindex='0']");
    target?.focus();
  }
  menuOpener = null;
  menuOpenerKey = null;
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
  setRepoOpen(repoId, true);
  showEmpty();
}

async function defaultFile(repoId: string): Promise<string | null> {
  if (!trees.has(repoId) || "error" in trees.get(repoId)!) await loadTree(repoId, false);
  const tree = trees.get(repoId);
  if (!tree || "error" in tree || !tree.files.length) return null;
  return pickNote(tree.files);
}

// ---------- document ----------

function openFile(repo: string, path: string) {
  if (session && session.repo === repo && session.path === path && !session.ended) return;
  closeSession();
  current = { repo, path };
  selectedRepo = repo;
  if (!isOpen(repoKey(repo), repo)) setRepoOpen(repo, true);
  if (!trees.has(repo)) void loadTree(repo);
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const key = dirKey(repo, parts.slice(0, i).join("/"));
    if (!isOpen(key, repo)) setOpenState(key, repo, true);
  }
  treeFocusKey = null;
  document.title = `${displayName(path)} · Grimoire`;
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
  document.title = "Grimoire";
  history.setTarget(null);
  renderHeader();
  updateSearchRepo();
  renderTree();
  const repo = writableRepoFor(selectedRepo);
  clear(docBody, h("div", { class: "empty-state" },
    h("span", { class: "label" }, repos.length ? "Nothing open" : "Welcome"),
    h("h2", null, repos.length ? "No note open." : "Start a notebook."),
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
    clear(sourceEl);
    clear(participantsEl);
    clear(saveStatusEl);
    return;
  }
  const { repo: repoId } = current;
  const repo = repoById(repoId);
  const parts = current.path.split("/");
  clear(breadcrumbEl,
    h("button", { type: "button", class: "crumb crumb-repo", onclick: () => ((selectedRepo = repoId), setRepoOpen(repoId, true), renderTree()) }, repo?.title ?? repoId),
    parts.slice(0, -1).flatMap((p) => [h("span", { class: "crumb-sep" }, "/"), h("span", { class: "crumb" }, p)]),
    h("span", { class: "crumb-sep" }, "/"),
    h("span", { class: "crumb crumb-file", title: current.path }, displayName(current.path)),
  );
  const fromGitHub = repo?.kind === "github" && repo.readOnly && repo.ghOwner && repo.ghName;
  clear(sourceEl, fromGitHub
    ? h("a", { class: "gh-source", href: githubFileUrl(repo.ghOwner!, repo.ghName!, repo.branch, current.path), target: "_blank", rel: "noopener noreferrer", title: `View ${current.path} on GitHub` },
        "Read-only · from GitHub", h("span", { class: "ext", "aria-hidden": "true" }, " ↗"))
    : null);
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
  let text: string | (string | HTMLElement)[];
  let cls = "";
  if (p.status !== "connected") {
    if (session.everConnected) {
      text = session.readOnly ? "Offline" : "Offline — changes will sync when reconnected";
      cls = "warn";
    } else text = "Connecting…";
  } else if (session.readOnly) {
    // Read-only GitHub copies say so next to the breadcrumb.
    text = sourceEl.childElementCount ? "" : "Read-only";
  } else if (s.saving) {
    text = "Saving…";
  } else if (s.dirty) {
    text = "Unsaved changes";
    cls = "dirty";
  } else if (s.commit) {
    const when = relativeTime(s.savedAt);
    text = ["Saved · ", h("code", { class: "sha" }, shortSha(s.commit)), when ? ` · ${when}` : ""];
  } else {
    text = "Not saved yet";
  }
  saveStatusEl.className = `save-status ${cls}`;
  clear(saveStatusEl, text);
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
  readonly provider: GrimoireProvider;
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
    this.provider = new GrimoireProvider(this.doc, repo, path);
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
      case "toolarge":
        return this.notice("File too large to open", `“${this.path}” is larger than 5 MB, too large to open as a note.`);
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
