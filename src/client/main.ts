// App shell: sidebar (repos, file tree, filter, search), document header, editor session, history, routing.
import { mountEditor, repoImages, type EditorHandle, type LinkTarget } from "./editor-rs/index.ts";
import { loadCollabEngine, preloadWasm } from "./editor-rs/engine.ts";
import { RustCollab, type ClosedReason, type CollabEvents } from "./editor-rs/collab.ts";
import { COULDNT_START, NOT_KEPT, STOPPED, showFallback, unsavedActions, unsavedBanner } from "./editor-rs/fallback.ts";
import { forgetAllUnsent, forgetUnsent, keepUnsent, keptUnsent, type KeptEdits } from "./editor-rs/unsent.ts";
import { api, ApiError, setGuest, subscribeEvents, type AppEvent, type Config, type Me, type PresenceUserInfo, type Repo, type SearchHit, type ServerInfo, type Tree, type Workspace } from "./api.ts";
import { anonIdentity, signInDialog, type AnonIdentity, type SignInReason } from "./signin.ts";
import { renderScratch } from "./scratch.ts";
import { HistoryPanel } from "./history.ts";
import { renderHome, renderStart } from "./home.ts";
import { agentPrompt, confirmDialog, copyText, promptDialog } from "./dialogs.ts";
import { hostOf, newDialog, openDialog, type OpenChoice, type WorkspaceRef, forgetRemote, rememberedRemotes, rememberRemote, workspaceUrl } from "./workspaces.ts";
import { githubFileUrl } from "../shared/github.ts";
import { autoNamePath, isUntitledPath, untitledPath } from "../shared/untitled.ts";
import { avatar, clear, colorFor, debounce, displayName, errorMessage, h, pickNote, toast, validPeerUser } from "./util.ts";
import type { PresenceState } from "../shared/presence.ts";

// ---------- state ----------

// the editor engine's wasm loads while the app starts
preloadWasm();

let config: Config;
let server: ServerInfo;
let me: Me;
/** Signed in (an account). Otherwise a guest: no account, a made-up name (`guest`); only folders need an account. */
let signedIn = false;
let guest: AnonIdentity | null = null;
/** The repos (workspaces) I know on this server, for their details. */
let repos: Repo[] = [];
/** The workspaces I've joined: the switcher's list for this server. */
let workspaces: Workspace[] = [];
/** The open workspace: the sidebar shows only its tree. */
let wsId: string | null = null;
const trees = new Map<string, Tree | { error: string }>();
/** Folder tree per repo, built once when its file list loads. */
const folderCache = new Map<string, Folder>();
/** Repos and folders the user opened or closed, keyed like tree rows ("repo:<id>", "dir:<repo>\0<path>"). Others use their default. */
const openState = new Map<string, boolean>();
const presence = new Map<string, PresenceUserInfo[]>();
let current: { repo: string; path: string } | null = null;
let session: Session | null = null;
let routeSeq = 0;
/** The tree row that takes Tab focus (roving tabindex). */
let treeFocusKey: string | null = null;
let treeFrame = 0;
/** Whether keyboard focus is in the tree (stays true while a re-render replaces the focused row). */
let treeHasFocus = false;
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

/** The demo folder (the server keeps it in memory and resets it every few hours). */
const DEMO_ID = "demo";
const fkey = (repo: string, path: string) => `${repo}\u0000${path}`;
const dirKey = (repo: string, path: string) => `dir:${fkey(repo, path)}`;
const repoById = (id: string | null) => (id ? repos.find((r) => r.id === id) : undefined);
const MD_EXT = /\.(md|markdown|mdx)$/i;
const TREE_STATE_KEY = "grimoire.tree.v2";
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
/** While filtering, each repo renders at most this many matching files. */
const FILTER_LIMIT = 100;

// ---------- elements ----------

const app = document.getElementById("app")!;
const treeEl = h("nav", { class: "sb-tree", "aria-label": "Files" });
const filterInput = h("input", { type: "search", class: "sb-filter-input", placeholder: "Filter files", autocomplete: "off", spellcheck: "false", "aria-label": "Filter files", "aria-keyshortcuts": "/" });
const agentCopyBtn = h("button", { type: "button", class: "btn btn-small", onclick: () => void copyAgentPrompt() }, "Copy") as HTMLButtonElement;
/** Pinned below the tree: copies the open folder's agent instructions (with my agent link for it). */
const agentCard = h("div", { class: "sb-agent", hidden: true }, h("span", { class: "sb-agent-label" }, "Share with an agent"), agentCopyBtn);
/** The very bottom of the sidebar: who's signed in; opens the account menu (upward). */
const accountBtn = h("button", { type: "button", class: "sb-account", "aria-haspopup": "menu", "aria-expanded": "false" });
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
const switcherBtn = h("button", { type: "button", class: "ws-switcher", "aria-haspopup": "menu", "aria-expanded": "false" });
const newNoteBtn = h("button", { type: "button", class: "quiet-btn new-note", onclick: () => void newNote() }, h("span", { class: "plus", "aria-hidden": "true" }), "New note");
let menuEl: HTMLElement | null = null;
let menuOpener: HTMLElement | null = null;
let menuOpenerKey: string | null = null;

// ---------- boot ----------

void boot();

async function boot() {
  try {
    config = await api.config();
    server = await api.server();
  } catch (err) {
    clear(app, h("div", { class: "fatal" }, "Couldn't reach the server: ", errorMessage(err)));
    return;
  }
  // Old note links (/r/...) live under /app now; the server redirects full page loads, this covers the rest.
  if (/^\/r(\/|$)/.test(location.pathname)) window.history.replaceState(null, "", "/app" + location.pathname.slice(2) + location.search + location.hash);
  const onStart = location.pathname === "/start";
  const onApp = isAppPath(location.pathname);
  // the scratch note needs nothing from the server (and no account)
  if (location.pathname === "/scratch") return void renderScratch(app);
  try {
    me = await api.me();
    signedIn = true;
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) {
      clear(app, h("div", { class: "fatal" }, errorMessage(err)));
      return;
    }
    if (!onApp) return onStart ? renderStart(app, config, server, false) : renderHome(app, config, server, false);
    // Not signed in: a guest, without an account. Others see my made-up name on my cursor and my commits.
    guest = anonIdentity();
    setGuest(guest);
    me = { id: `guest:${guest.id}`, login: "", name: guest.name, email: "", avatar: null, color: guest.color };
  }
  if (onStart) return renderStart(app, config, server, true);
  if (!onApp) return renderHome(app, config, server, true);
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
  switcherBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menuEl && menuOpener === switcherBtn) return closeMenu();
    void openSwitcher();
  });
  switcherBtn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      void openSwitcher();
    }
  });
  renderSwitcher();
  accountBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!signedIn) return openSignIn(null);
    if (menuEl && menuOpener === accountBtn) return closeMenu();
    openAccountMenu();
  });
  accountBtn.addEventListener("keydown", (e) => {
    if (signedIn && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      openAccountMenu();
    }
  });
  renderAccount();

  filterInput.addEventListener("input", onFilterInput);
  filterInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (filterInput.value) {
        e.preventDefault();
        filterInput.value = "";
        onFilterInput();
      } else filterInput.blur();
    } else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey && filterInput.value)) {
      flushTree();
      const first = visibleRows()[0];
      if (!first) return;
      e.preventDefault();
      moveTo(first);
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
  document.addEventListener("focusin", (e) => {
    treeHasFocus = treeEl.contains(e.target as Node);
  }, true);
  treeEl.addEventListener("focusin", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[role=treeitem]");
    if (row?.dataset.key) {
      treeFocusKey = row.dataset.key;
      applyRoving();
    }
  });

  clear(app,
    h("aside", { class: "sidebar", id: "sidebar" },
      h("div", { class: "sb-head" }, switcherBtn),
      h("div", { class: "sb-tools" },
        h("label", { class: "sb-filter" }, filterInput, h("kbd", { "aria-hidden": "true" }, "/")),
        h("div", { class: "sb-actions" }, newNoteBtn),
      ),
      treeEl,
      agentCard,
      accountBtn,
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
    // Notes save themselves; Cmd/Ctrl-S just shouldn't open the browser's "Save page" dialog.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") e.preventDefault();
    // ⌘⇧E (Ctrl+Shift+E elsewhere): the file tree, at the current row, from anywhere.
    if ((IS_MAC ? e.metaKey : e.ctrlKey) && e.shiftKey && !e.altKey && e.code === "KeyE") {
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      focusTree();
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

async function changeName() {
  const name = await promptDialog({ title: "Change name", label: "Name", value: me.name, submit: "Save", hint: "Shown on your cursor and on your commits." });
  if (!name?.trim() || name.trim() === me.name) return;
  try {
    await api.setName(name.trim());
    location.reload();
  } catch (err) {
    toast(errorMessage(err), "error");
  }
}

async function logout() {
  try {
    await api.logout();
  } catch {}
  forgetAllUnsent(me.id);
  location.href = "/";
}

// ---------- workspace switcher ----------

const joinedById = (id: string | null) => (id ? workspaces.find((w) => w.id === id) : undefined);

function workspaceTitle(id: string | null) {
  return joinedById(id)?.title ?? repoById(id)?.title ?? id ?? "No folder";
}

function renderSwitcher() {
  const title = workspaceTitle(wsId);
  clear(switcherBtn,
    h("span", { class: "ws-mark", "aria-hidden": "true" }, (title.trim()[0] ?? "?").toUpperCase()),
    h("span", { class: "ws-text" }, h("span", { class: "ws-title" }, title), h("span", { class: "ws-host" }, location.host)),
    h("span", { class: "chev chev-down", "aria-hidden": "true" }),
  );
  switcherBtn.title = `${title} · ${location.host}`;
  switcherBtn.setAttribute("aria-label", `${title} on ${location.host}. Switch folder`);
  newNoteBtn.hidden = !writableRepoFor(wsId);
  const ws = repoById(wsId);
  // handing a folder to an agent is for people who are signed in: guests don't see it at all
  agentCard.hidden = !signedIn || ws?.status !== "ready";
}

/** The switcher's order: case-insensitive natural order, ties by id, so it never depends on which folder is open. */
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

async function openSwitcher() {
  const here = location.host;
  const remotes = rememberedRemotes();
  const ws = repoById(wsId);
  const joined = joinedById(wsId);
  // × asks first (and can't take off the only folder in the list)
  const rows = workspaces.length + remotes.length;
  const leaveX = (name: string, run: () => void) => ({ label: `Remove ${name} from your list`, run: () => void removeFromList(name, rows, run) });
  type Row = { id: string; title: string; item: MenuItem };
  const groups = new Map<string, Row[]>();
  const add = (host: string, row: Row) => groups.set(host, [...(groups.get(host) ?? []), row]);
  groups.set(here, []);
  // signed in: the folders I've joined; a guest: the ones this browser opened
  for (const w of workspaces) add(here, { id: w.id, title: w.title, item: { label: w.title, checked: w.id === wsId, run: () => switchWorkspace(w.id), remove: leaveX(w.title, () => void leaveWorkspace(w)) } });
  // the open folder isn't in my list (e.g. the default notebook opened through its link): still shown, checked
  if (wsId && !joined && ws) add(here, { id: ws.id, title: ws.title, item: { label: ws.title, checked: true, run: () => {} } });
  for (const r of remotes) {
    const name = r.title ?? r.workspace;
    add(hostOf(r.origin), { id: `${r.origin}/${r.workspace}`, title: name, item: { label: name, checked: false, run: () => (location.href = workspaceUrl(r)), remove: leaveX(name, () => (forgetRemote(r), toast(`Removed ${name} from your list`))) } });
  }
  // servers by host name (this one sorts with the others), folders by name: the same order whichever is open
  const sorted = [...groups].sort(([a], [b]) => byName(a, b) || (a < b ? -1 : a > b ? 1 : 0));
  const items: MenuItem[] = [
    ...sorted.flatMap(([host, list]): MenuItem[] => [
      { section: host },
      ...list.sort((a, b) => byName(a.title, b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => r.item),
      host === here && !list.length ? { label: "No folders yet", run: () => newFolder(), disabled: true } : null,
    ]),
    "sep",
    { label: "New…", run: () => newFolder() },
    { label: "Open…", run: () => requireAccount() && openFolder() },
    ws ? "sep" : null,
    ws?.kind === "github" && ws.ghOwner ? { label: "Open on GitHub", run: () => window.open(`https://github.com/${ws.ghOwner}/${ws.ghName}`, "_blank", "noopener") } : null,
    ws?.canRemove ? { label: "Remove folder…", run: () => void removeRepo(ws) } : null,
  ];
  showMenu(switcherBtn, items, { keepOrder: true, className: "ws-menu" });
}

/** My email, unless it's a name sign-in's made-up @localhost one. */
const myEmail = () => (me.email && !me.email.endsWith("@localhost") ? me.email : "");

function renderAccount() {
  if (!signedIn) {
    // a guest: just "Sign in" (the methods in a dialog)
    clear(accountBtn, h("span", { class: "sb-account-name" }, "Sign in"));
    accountBtn.classList.add("sb-signin");
    accountBtn.removeAttribute("aria-haspopup");
    accountBtn.removeAttribute("aria-expanded");
    accountBtn.title = `Not signed in: others see you as ${me.name}`;
    accountBtn.setAttribute("aria-label", "Sign in");
    return;
  }
  const user = avatar(me);
  user.removeAttribute("title");
  clear(accountBtn, user, h("span", { class: "sb-account-name" }, me.name));
  accountBtn.title = myEmail() ? `${me.name} · ${myEmail()}` : me.name;
  accountBtn.setAttribute("aria-label", `Signed in as ${me.name}. Account`);
}

/** The account row's menu, opening upward: my email, Change name…, Sign out. */
function openAccountMenu() {
  showMenu(accountBtn, [
    myEmail() ? { section: myEmail() } : null,
    { label: "Change name…", run: changeName },
    { label: "Sign out", run: logout },
  ], { keepOrder: true, above: true, className: "account-menu" });
}

function switchWorkspace(id: string) {
  if (id === wsId && current) return;
  window.history.pushState(null, "", urlFor(id));
  void route();
}

/** My agent link per folder, once fetched: later copies don't wait for the server (and keep the click's permission to copy). */
const agentUrls = new Map<string, string>();

/** The sidebar card's Copy: create or reuse my agent link for the open folder and copy the instructions with it. */
async function copyAgentPrompt() {
  const ws = repoById(wsId);
  if (!ws) return;
  let url = agentUrls.get(ws.id);
  if (!url) {
    agentCopyBtn.disabled = true;
    try {
      url = (await api.myShare(ws.id)).url;
      agentUrls.set(ws.id, url);
    } catch (err) {
      return toast(errorMessage(err), "error");
    } finally {
      agentCopyBtn.disabled = false;
    }
  }
  if (!(await copyText(agentPrompt(url)))) return toast("Couldn't copy to the clipboard. Try again.", "error");
  agentCopyBtn.textContent = "Copied";
  setTimeout(() => (agentCopyBtn.textContent = "Copy"), 1500);
}

/** "New…": create a folder on this server and open it. */
function newFolder() {
  if (!requireAccount()) return;
  newDialog({ create: createWorkspace });
}

// ---------- not signed in (a guest) ----------

/** Signed in, true; else the sign-in dialog (creating and opening folders needs an account) and false. */
function requireAccount(): boolean {
  if (signedIn) return true;
  openSignIn("folders");
  return false;
}

function openSignIn(reason: SignInReason) {
  closeMenu(false);
  const scratch = current ? `/scratch?${new URLSearchParams({ from: `${current.repo}/${current.path}` })}` : "/scratch";
  // guests not in the demo folder are pointed at it too
  signInDialog(config, server, { reason, name: signedIn ? "" : me.name, scratch, demo: !signedIn && wsId !== DEMO_ID });
}

/**
 * The switcher's ×: asks first ("Remove <name> from your list?"), then `remove`. The only folder in the list can't
 * go: a dialog says to make another one first.
 */
async function removeFromList(name: string, rows: number, remove: () => void) {
  closeMenu(false);
  if (rows <= 1) {
    const make = await confirmDialog({ title: "Can't remove your only folder", message: "You can't remove the only folder in your list. Create a new folder first, then remove this one.", confirm: "New folder…", cancel: "OK" });
    if (make) newFolder();
    return;
  }
  const ok = await confirmDialog({ title: `Remove ${name} from your list?`, message: "This doesn't delete the folder. All existing links to it keep working, and if you open a link to it again, it'll come back to your list.", confirm: "Remove" });
  if (ok) remove();
}

// The folders a guest opened, remembered in this browser (their switcher's list; × takes one off).
const VISITED_KEY = "grimoire.visited.v1";

function visited(): Workspace[] {
  try {
    const raw = JSON.parse(localStorage.getItem(VISITED_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((w): w is Workspace => !!w && typeof w.id === "string" && typeof w.title === "string" && (w.kind === "notes" || w.kind === "github"));
  } catch {
    return [];
  }
}

function rememberVisited(r: Repo) {
  const list = [{ id: r.id, title: r.title, kind: r.kind, readOnly: r.readOnly }, ...visited().filter((w) => w.id !== r.id)].slice(0, 50);
  try {
    localStorage.setItem(VISITED_KEY, JSON.stringify(list));
  } catch {}
}

function forgetVisited(id: string) {
  try {
    localStorage.setItem(VISITED_KEY, JSON.stringify(visited().filter((w) => w.id !== id)));
  } catch {}
  forgetLastNote(id);
}

/** "Open…": open a remote folder by URL, add a GitHub repo, or create a remote folder. */
function openFolder(start?: OpenChoice) {
  const seq = routeSeq;
  openDialog(config, {
    openRemote: (ref) => void openRemote(ref),
    added(repo) {
      if (!repoById(repo.id)) repos = [...repos, repo];
      void loadRepos();
    },
    async ready(repo, path, inDialog) {
      await loadRepos();
      // Imports that finish after the dialog was closed only open a note if the user hasn't gone elsewhere.
      if (!path || (!inDialog && seq !== routeSeq)) return;
      navigate(repo.id, path);
    },
  }, start);
}

/**
 * Open… → URL: a folder or note link. This server: open the folder (which records the join) and the note, or the
 * folder with "No note at <path>" when the note doesn't exist. Another server: remembered in the switcher, then
 * navigated to (the folder or the note).
 */
async function openRemote(ref: WorkspaceRef) {
  if (ref.origin === location.origin) {
    let path = ref.path;
    if (path) {
      if (!MD_EXT.test(path)) path += ".md";
      try {
        const tree = await api.tree(ref.workspace);
        const found = tree.files.includes(path) ? path : tree.files.find((f) => f.toLowerCase() === path!.toLowerCase());
        if (!found) toast(`No note at “${path}”`);
        path = found ?? null;
      } catch {
        // (the folder may not exist: route() says so)
      }
    }
    window.history.pushState(null, "", urlFor(ref.workspace, path ?? undefined));
    await route();
    return;
  }
  rememberRemote(ref);
  location.href = workspaceUrl(ref);
}

/** Take a folder off my list (the switcher's ×, confirmed): leave it (signed in) or forget it here (a guest). */
async function leaveWorkspace(w: Workspace) {
  if (signedIn) {
    try {
      await api.leaveWorkspace(w.id);
    } catch (err) {
      return toast(errorMessage(err), "error");
    }
    forgetLastNote(w.id);
    await loadRepos();
  } else {
    forgetVisited(w.id);
    workspaces = visited();
    renderSwitcher();
  }
  toast(`Removed ${w.title} from your list`);
  if (w.id !== wsId) return;
  const next = workspaces.find((x) => x.id !== w.id);
  if (next) switchWorkspace(next.id);
  else {
    closeSession();
    wsId = null;
    goHome(true);
  }
}

// ---------- data ----------

/** Reload the repo and workspace lists and the open workspace's tree (reloaded when `refresh`). */
async function loadRepos(refresh = false) {
  try {
    const [r, w] = await Promise.all([
      api.repos(),
      signedIn ? api.workspaces().catch((err: unknown) => (console.warn("workspaces:", err), workspaces)) : Promise.resolve(visited()),
    ]);
    // the open workspace stays known even if it isn't listed (e.g. opened before its join was recorded)
    const open = repoById(wsId);
    repos = open && !r.some((x) => x.id === open.id) ? [...r, open] : r;
    workspaces = w;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return location.reload();
    toast(`Couldn't load folders: ${errorMessage(err)}`, "error");
  }
  for (const id of [...trees.keys()]) {
    if (!repoById(id)) {
      trees.delete(id);
      folderCache.delete(id);
    }
  }
  // A tree that failed to load (e.g. while the repo was importing) is retried too.
  const ws = repoById(wsId);
  if (ws && ws.status === "ready" && ((refresh && trees.has(ws.id)) || !trees.has(ws.id) || "error" in trees.get(ws.id)!)) await loadTree(ws.id, false);
  renderTree();
  renderHeader();
  renderSwitcher();
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
  const ws = repoById(wsId);
  if (q && ws && !trees.has(ws.id) && ws.status === "ready") void loadTree(ws.id);
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
  const ws = repoById(wsId);
  if (!ws) {
    clear(treeEl, wsId ? null : h("div", { class: "sb-empty" }, h("p", null, "No folders yet."), h("button", { class: "btn", type: "button", onclick: () => newFolder() }, "New remote folder")));
  } else {
    clear(treeEl, renderWorkspaceTree(ws, q), q ? renderSearchResults() : null);
  }
  applyRoving();
  treeEl.scrollTop = scroll;
  if ((focusKey || treeHasFocus) && (document.activeElement === document.body || !document.activeElement)) {
    const row = (focusKey && treeEl.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)) || treeEl.querySelector<HTMLElement>("[role=treeitem][tabindex='0']");
    row?.focus({ preventScroll: true });
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
  for (const r of rows) {
    r.tabIndex = r === target ? 0 : -1;
    r.setAttribute("aria-selected", String(r === target));
  }
}

function focusRow(row: HTMLElement | undefined) {
  if (!row) return;
  treeFocusKey = row.dataset.key ?? null;
  applyRoving();
  row.focus();
  row.scrollIntoView({ block: "nearest" });
}

let openTimer = 0;

/** Keyboard move onto a row: a note opens at once (focus stays in the tree); a folder is only selected. */
function moveTo(row: HTMLElement | undefined, repeat = false) {
  if (!row) return;
  focusRow(row);
  clearTimeout(openTimer);
  if (!row.classList.contains("file-row") || row.getAttribute("aria-current") === "page") return;
  const open = rowActions.get(row)?.activate;
  if (!open) return;
  // Held arrow keys open only the row they stop on.
  if (repeat) openTimer = window.setTimeout(open, 150);
  else open();
}

/** Focus the file tree at its current row (⌘⇧E). */
function focusTree() {
  setSidebarOpen(true);
  flushTree();
  const row = treeEl.querySelector<HTMLElement>("[role=treeitem][tabindex='0']") ?? visibleRows()[0];
  if (row) focusRow(row);
  else filterInput.focus();
}

/** Focus the open note's editor (caret where it was), or the next one to mount. */
function focusEditor() {
  if (session && !session.focus()) focusNextEditor = true;
}

const typeAhead = { text: "", at: 0 };

/** Jump to the next row whose name starts with what was typed in the last second. */
function typeAheadKey(key: string, rows: HTMLElement[], i: number) {
  const now = performance.now();
  typeAhead.text = now - typeAhead.at > 1000 ? key : typeAhead.text + key;
  typeAhead.at = now;
  const t = typeAhead.text.toLowerCase();
  const name = (r: HTMLElement) => (r.querySelector(".file-name, .folder-name")?.textContent ?? "").toLowerCase();
  // A single letter looks past the current row (pressing it again cycles); a longer prefix may stay on it.
  const start = t.length === 1 ? i + 1 : Math.max(i, 0);
  for (let k = 0; k < rows.length; k++) {
    const r = rows[(start + k) % rows.length]!;
    if (name(r).startsWith(t)) return moveTo(r);
  }
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
  const isNote = row.classList.contains("file-row");
  let handled = true;
  switch (e.key) {
    case "ArrowDown":
      if (i < rows.length - 1) moveTo(rows[i + 1], e.repeat);
      break;
    case "ArrowUp":
      if (i > 0) moveTo(rows[i - 1], e.repeat);
      break;
    case "Home":
      moveTo(rows[0]);
      break;
    case "End":
      moveTo(rows[rows.length - 1]);
      break;
    case "ArrowRight":
      if (expanded === "false") acts?.setOpen?.(true);
      else if (expanded === "true" && rows[i + 1] && parentRow(rows[i + 1]!) === row) moveTo(rows[i + 1]);
      break;
    case "ArrowLeft":
      if (expanded === "true" && !filterQuery()) acts?.setOpen?.(false);
      else moveTo(parentRow(row));
      break;
    case "Enter":
    case " ":
      if (e.key === " " && typeAhead.text && performance.now() - typeAhead.at < 1000) {
        typeAheadKey(" ", rows, i);
        break;
      }
      if (!isNote) acts?.activate();
      else {
        // The note opens (if a held arrow hasn't opened it yet) and takes focus.
        clearTimeout(openTimer);
        if (row.getAttribute("aria-current") !== "page") {
          focusNextEditor = true;
          acts?.activate();
        } else focusEditor();
      }
      break;
    case "Escape":
      focusEditor();
      break;
    case "Tab":
      if (e.shiftKey || !session) return;
      focusEditor();
      break;
    case "F10":
      if (!e.shiftKey) return;
      showMenu(row, acts?.menu() ?? []);
      break;
    case "ContextMenu":
      showMenu(row, acts?.menu() ?? []);
      break;
    default:
      if (e.key.length === 1 && e.key !== "/" && e.key !== " ") typeAheadKey(e.key, rows, i);
      else handled = false;
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

/** The open workspace's files: the sidebar's tree. */
function renderWorkspaceTree(repo: Repo, q: string): HTMLElement {
  const tree = trees.get(repo.id);
  const loaded = tree && !("error" in tree) ? tree : null;
  const note = (text: string, error = false) => h("p", { class: `tree-note${error ? " error" : ""}` }, text);
  if (repo.status === "importing" && !loaded?.files.length) return note("Importing…");
  if (repo.status === "error") return note(repo.error ?? "The import failed.", true);
  if (!tree) return note("Loading…");
  if (!loaded) return note((tree as { error: string }).error, true);
  if (!loaded.files.length) return note("No notes yet.");
  const root = (folder: Folder) => {
    const ul = renderFolder(repo, folder, 1, q);
    ul.setAttribute("role", "tree");
    ul.className = "tree";
    ul.setAttribute("aria-label", q ? "Matching files" : `Files in ${repo.title}`);
    return ul;
  };
  if (!q) return root(folderCache.get(repo.id) ?? buildFolders(loaded.files));
  const matches = loaded.files.filter((f) => matchesFilter(f, q));
  if (!matches.length) return note("No file names match.");
  const shown = matches.slice(0, FILTER_LIMIT);
  return h("div", null,
    root(buildFolders(shown)),
    matches.length > shown.length ? note(`Showing ${shown.length} of ${matches.length}. Type more to narrow it down.`) : null,
  );
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
      "data-key": key, title: f.path, style: { "--depth": String(level) },
      onclick: (e: MouseEvent) => (focusRow(e.currentTarget as HTMLElement), setOpen(!open)),
    },
      chevron(),
      h("span", { class: "folder-name" }, f.name),
    );
    const writable = !repo.readOnly;
    const here = () => void newNote(repo.id, `${f.path}/`);
    bindRow(row, { activate: () => setOpen(!open), setOpen, menu: () => (writable ? [{ label: "New note", run: here }] : []) });
    const add = writable
      ? h("button", { type: "button", class: "icon-btn row-add folder-add", tabindex: "-1", title: `New note in ${f.name}`, "aria-label": `New note in ${f.name}`, onclick: (e: MouseEvent) => (e.preventDefault(), e.stopPropagation(), here()) }, "+")
      : null;
    ul.appendChild(h("li", { role: "none", class: "folder-item" }, row, add, open ? group(row, renderFolder(repo, f, level + 1, q)) : null));
  }
  for (const path of folder.files) ul.appendChild(renderFile(repo, path, level, q));
  return ul;
}

function renderFile(repo: Repo, path: string, level: number, q: string) {
  const active = current?.repo === repo.id && current.path === path;
  const users = (presence.get(fkey(repo.id, path)) ?? []).filter((u) => u.id !== me.id);
  const writable = !repo.readOnly;
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
    "aria-current": active ? "page" : undefined,
    "data-key": key, style: { "--depth": String(level) }, title: path,
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
    // A click focuses the tree on the row; Enter, Tab or Escape then goes to the editor.
    focusRow(a);
    navigate(repo.id, path);
  });
  bindRow(a, { activate: () => navigate(repo.id, path), menu: items });
  return h("li", { role: "none", class: `file-item${active ? " active" : ""}` }, a, menuButton(key, `${name} actions`, items));
}

// ---------- search (note contents, shown under the filtered tree) ----------

function searchRepoId() {
  return wsId;
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

/** The workspace if I can write in it. */
function writableRepoFor(id: string | null | undefined): Repo | undefined {
  const r = repoById(id ?? null);
  return r && !r.readOnly ? r : undefined;
}

/** Make the next mounted editor take focus (a note just created from the sidebar). */
let focusNextEditor = false;

/**
 * "New note": at once, the first free Untitled.md (Untitled 2.md, …) in `dir` (default: the open note's folder),
 * opened with the caret at the start. Its first-line H1 names it later (Session.autoName).
 */
async function newNote(repoId?: string, dir?: string) {
  const repo = writableRepoFor(repoId ?? wsId);
  if (!repo) return toast("You can't add notes to this folder.", "error");
  const folder = dir ?? (current && current.repo === repo.id && current.path.includes("/") ? current.path.slice(0, current.path.lastIndexOf("/") + 1) : "");
  if (!trees.has(repo.id) || "error" in trees.get(repo.id)!) await loadTree(repo.id, false);
  // names the server already has (a note may not be in the tree until it's committed)
  const tried: string[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const tree = trees.get(repo.id);
    const path = untitledPath([...(tree && !("error" in tree) ? tree.files : []), ...tried], folder);
    try {
      const res = await api.createFile(repo.id, path, "");
      await loadTree(repo.id, false);
      focusNextEditor = true;
      navigate(repo.id, res.path);
      return;
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409)) return toast(errorMessage(err), "error");
      tried.push(path);
    }
  }
  toast("Couldn't find a free name for the new note.", "error");
}

async function createWorkspace(title: string) {
  const ws = await api.createWorkspace(title);
  await loadRepos();
  switchWorkspace(ws.id);
  toast(`Created “${ws.title}”`);
}

// For the open file, the server closes its room ("removed" / "renamed" / "deleted") and Session.onClosed navigates.

async function removeRepo(repo: Repo) {
  const ok = await confirmDialog({ title: "Remove folder", message: `Remove “${repo.title}” from Grimoire for everyone who has it?`, confirm: "Remove", danger: true });
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

type MenuAction = { label: string; run: () => void; danger?: boolean; detail?: string; checked?: boolean; disabled?: boolean; /** A × at the right of the row (its label is the aria-label). */ remove?: { label: string; run: () => void } };
type MenuItem = MenuAction | { section: string } | "sep" | null;
const isAction = (i: MenuItem): i is MenuAction => !!i && typeof i === "object" && "run" in i;

/**
 * Open a menu below an element (its opener), or at a point (e.g. a right-click). Destructive items go last, after a
 * separator, unless `keepOrder` (then "sep" and {section} entries lay it out).
 */
function showMenu(at: HTMLElement | { x: number; y: number }, items: MenuItem[], opts: { opener?: HTMLElement; alignRight?: boolean; above?: boolean; header?: string; keepOrder?: boolean; className?: string } = {}) {
  closeMenu(false);
  const list = opts.keepOrder ? items.filter((i) => i !== null) : items.filter(isAction);
  if (!list.some(isAction)) return;
  const anchor = at instanceof HTMLElement ? at : null;
  const opener = opts.opener ?? anchor ?? (document.activeElement as HTMLElement | null);
  menuOpener = opener;
  menuOpenerKey = opener ? opener.dataset.key ?? opener.dataset.for ?? opener.closest<HTMLElement>("[data-key]")?.dataset.key ?? null : null;
  if (opener?.hasAttribute("aria-haspopup")) opener.setAttribute("aria-expanded", "true");
  const actions = list.filter(isAction);
  const ordered: MenuItem[] = opts.keepOrder ? list : [...actions.filter((i) => !i.danger), ...actions.filter((i) => i.danger)];
  const firstDanger = opts.keepOrder ? -1 : ordered.findIndex((i) => isAction(i) && i.danger);
  const buttons: HTMLButtonElement[] = [];
  const nodes: HTMLElement[] = [];
  const sep = () => h("div", { class: "menu-sep", role: "separator" });
  ordered.forEach((i, n) => {
    if (i === "sep") {
      if (nodes.length && !nodes[nodes.length - 1]!.classList.contains("menu-sep")) nodes.push(sep());
      return;
    }
    if (!i) return;
    if (!isAction(i)) {
      nodes.push(h("div", { class: "menu-section", role: "presentation" }, i.section));
      return;
    }
    if (n > 0 && n === firstDanger) nodes.push(sep());
    const b = h("button", {
      type: "button", class: `menu-item${i.danger ? " danger" : ""}${i.detail !== undefined ? " has-detail" : ""}`, role: i.checked !== undefined ? "menuitemradio" : "menuitem", tabindex: "-1",
      "aria-checked": i.checked !== undefined ? String(!!i.checked) : undefined, disabled: i.disabled,
      onclick: (e: MouseEvent) => (e.stopPropagation(), closeMenu(false), i.run()),
    },
      i.checked !== undefined ? h("span", { class: `menu-check${i.checked ? " on" : ""}`, "aria-hidden": "true" }) : null,
      h("span", { class: "menu-label" }, i.label),
      i.detail ? h("span", { class: "menu-detail" }, i.detail) : null,
    );
    if (!i.disabled) buttons.push(b);
    if (!i.remove) return void nodes.push(b);
    const { label, run } = i.remove;
    const x = h("button", {
      type: "button", class: "menu-remove", tabindex: "-1", "aria-label": label, title: label,
      onclick: (e: MouseEvent) => (e.stopPropagation(), run()),
    }, "×") as HTMLButtonElement;
    buttons.push(x);
    nodes.push(h("div", { class: "menu-row", role: "presentation" }, b, x));
  });
  while (nodes.length && nodes[nodes.length - 1]!.classList.contains("menu-sep")) nodes.pop();
  const menu = h("div", { class: `menu${opts.className ? ` ${opts.className}` : ""}`, role: "menu" },
    opts.header ? h("div", { class: "menu-header", "aria-hidden": "true" }, opts.header) : null,
    opts.header ? sep() : null,
    nodes,
  );
  menu.addEventListener("keydown", (e) => {
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = (idx + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]!.focus();
    } else if ((e.key === "ArrowRight" || e.key === "Delete" || e.key === "Backspace") && (document.activeElement?.nextElementSibling as HTMLElement | null)?.classList.contains("menu-remove")) {
      e.preventDefault();
      const x = document.activeElement!.nextElementSibling as HTMLButtonElement;
      if (e.key === "ArrowRight") x.focus();
      else x.click();
    } else if (e.key === "ArrowLeft" && document.activeElement?.classList.contains("menu-remove")) {
      e.preventDefault();
      (document.activeElement.previousElementSibling as HTMLElement).focus();
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
  const GAP = 4;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    x = opts.alignRight ? r.right - rect.width : r.left;
    // A left-aligned menu that would run off the right edge lines up with the trigger's right edge instead.
    if (!opts.alignRight && x + rect.width > window.innerWidth - 8) x = r.right - rect.width;
    // Below the trigger (above it with `above`, or when there isn't room below), so the menu never covers its button.
    y = r.bottom + GAP;
    if ((opts.above || y + rect.height > window.innerHeight - 8) && r.top - GAP - rect.height >= 8) y = r.top - GAP - rect.height;
  } else {
    ({ x, y } = at as { x: number; y: number });
    if (y + rect.height > window.innerHeight - 8) y = Math.max(8, y - rect.height);
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

function isAppPath(p: string) {
  return p === "/app" || p.startsWith("/app/");
}

function urlFor(repo: string, path?: string) {
  return `/app/${encodeURIComponent(repo)}` + (path ? "/" + path.split("/").map(encodeURIComponent).join("/") : "");
}

function parseRoute(): { repo: string; path: string | null } | null {
  const m = location.pathname.match(/^\/app\/([^/]+)(?:\/(.*))?$/);
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

/** Back to the app root's default note (not the last-opened one: going home usually means that note is gone). */
let skipLastNote = false;
function goHome(replace = false) {
  skipLastNote = true;
  if (replace) window.history.replaceState(null, "", "/app");
  else window.history.pushState(null, "", "/app");
  void route();
}

// The note last opened, per user: /app reopens it.
const LAST_NOTE_KEY = "grimoire.lastNote.v1";

function readLastNote(): { repo: string; path: string } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_NOTE_KEY) ?? "null") as { user?: string; repo?: unknown; path?: unknown } | null;
    if (raw?.user === me.id && typeof raw.repo === "string" && typeof raw.path === "string") return { repo: raw.repo, path: raw.path };
  } catch {}
  return null;
}

function saveLastNote(repo: string, path: string) {
  try {
    localStorage.setItem(LAST_NOTE_KEY, JSON.stringify({ user: me.id, repo, path }));
    const all = lastNotes();
    delete all[repo];
    // newest last; keep the newest 100 workspaces
    localStorage.setItem(LAST_BY_WS_KEY, JSON.stringify({ user: me.id, notes: Object.fromEntries([...Object.entries(all), [repo, path]].slice(-100)) }));
  } catch {}
}

// The note last opened in each workspace: switching to a workspace reopens it.
const LAST_BY_WS_KEY = "grimoire.lastNoteByWorkspace.v1";

function lastNotes(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_BY_WS_KEY) ?? "null") as { user?: string; notes?: Record<string, unknown> } | null;
    if (raw?.user !== me.id || !raw.notes || typeof raw.notes !== "object") return {};
    return Object.fromEntries(Object.entries(raw.notes).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

function forgetLastNote(repo: string) {
  try {
    const all = lastNotes();
    delete all[repo];
    localStorage.setItem(LAST_BY_WS_KEY, JSON.stringify({ user: me.id, notes: all }));
    if (readLastNote()?.repo === repo) localStorage.removeItem(LAST_NOTE_KEY);
  } catch {}
}

/** The workspace /app opens when nothing else says which: the first joined one, else the first I can open. */
function firstWorkspace(): string | null {
  const joined = workspaces.filter((w) => repoById(w.id));
  return joined.find((w) => w.kind === "notes")?.id ?? joined[0]?.id ?? repos.find((x) => x.kind === "notes")?.id ?? repos[0]?.id ?? null;
}

async function route() {
  const seq = ++routeSeq;
  // Outside /app (e.g. back to the home page): that's a different page.
  if (!isAppPath(location.pathname)) return location.reload();
  const skipLast = skipLastNote;
  skipLastNote = false;
  setSidebarOpen(false);
  const r = parseRoute();
  const last = !r && !skipLast ? readLastNote() : null;
  const id = r?.repo ?? (last && repoById(last.repo) ? last.repo : null) ?? (skipLast && repoById(wsId) ? wsId : null) ?? firstWorkspace();
  if (!id) {
    setWorkspace(null);
    return showEmpty();
  }
  if (!(await openWorkspace(id))) return;
  if (seq !== routeSeq) return;
  if (r?.path) {
    const canonical = urlFor(r.repo, r.path);
    if (location.pathname !== canonical) window.history.replaceState(null, "", canonical + location.search + location.hash);
    return openFile(r.repo, r.path);
  }
  const remembered = skipLast ? undefined : lastNotes()[id];
  if (repoById(id)?.status !== "ready") {
    if (seq === routeSeq) showEmpty();
    return;
  }
  const target = await defaultFile(id, remembered);
  if (seq !== routeSeq) return;
  if (target) {
    window.history.replaceState(null, "", urlFor(id, target));
    return openFile(id, target);
  }
  if (location.pathname !== urlFor(id)) window.history.replaceState(null, "", urlFor(id));
  showEmpty();
}

function setWorkspace(id: string | null) {
  if (id === wsId) return;
  wsId = id;
  treeFocusKey = null;
  if (filterInput.value) filterInput.value = "";
  runSearch();
  renderSwitcher();
  renderTree();
}

/**
 * Make `id` the open workspace. One that doesn't exist (or can't be loaded) shows why instead; false then.
 * Opening one that isn't in my list yet records the join on the server, so the list is reloaded after.
 */
async function openWorkspace(id: string): Promise<boolean> {
  if (!repoById(id)) {
    try {
      const repo = await api.repo(id);
      repos = [...repos.filter((x) => x.id !== id), repo];
    } catch (err) {
      setWorkspace(id);
      showMissing(id, err);
      return false;
    }
  }
  setWorkspace(id);
  if (!signedIn) {
    rememberVisited(repoById(id)!);
    workspaces = visited();
    renderSwitcher();
  } else if (!joinedById(id)) {
    void (async () => {
      if (!trees.has(id) && repoById(id)?.status === "ready") await loadTree(id, false);
      workspaces = await api.workspaces().catch(() => workspaces);
      renderSwitcher();
    })();
  }
  return true;
}

function showMissing(id: string, err: unknown) {
  closeSession();
  current = null;
  document.title = "Grimoire";
  history.setTarget(null);
  renderHeader();
  const missing = err instanceof ApiError && err.status === 404;
  clear(docBody, h("div", { class: "empty-state no-folder" },
    h("h2", null, missing ? "No such folder" : "Couldn't open this folder"),
    h("p", { class: "muted" }, missing ? `“${id}” doesn't exist on ${location.host}.` : errorMessage(err)),
    h("div", { class: "row" }, h("button", { type: "button", class: "btn", onclick: () => goHome() }, "Go to my folders")),
  ));
}

async function defaultFile(repoId: string, file?: string): Promise<string | null> {
  if (!trees.has(repoId) || "error" in trees.get(repoId)!) await loadTree(repoId, false);
  const tree = trees.get(repoId);
  if (!tree || "error" in tree || !tree.files.length) return null;
  return pickNote(tree.files, file ? { file } : {});
}

// ---------- links in notes ----------

/** A link clicked in `s`'s note (the editor scrolls to `#heading` links itself). */
function openLink(s: Session, t: LinkTarget) {
  switch (t.kind) {
    case "external":
      window.open(t.url, "_blank", "noopener,noreferrer");
      return;
    case "app":
      return goTo(t.url);
    case "outside":
      toast(`“${t.path}” is outside this notebook.`, "error");
      return;
    case "file":
      if (!t.note) {
        window.open(rawUrl(s.repo, t.path), "_blank", "noopener,noreferrer");
        return;
      }
      return void openNoteLink(s.repo, t.path, t.fragment);
    default:
      return;
  }
}

function rawUrl(repo: string, path: string) {
  return `/api/repos/${encodeURIComponent(repo)}/raw?${new URLSearchParams({ path })}`;
}

/** Open note `path` of `repo` (from a link), or offer to create it. */
async function openNoteLink(repo: string, path: string, fragment: string | null) {
  const url = (p: string) => urlFor(repo, p) + (fragment ? "#" + encodeURIComponent(fragment) : "");
  if (session && session.repo === repo && session.path === path) return goTo(url(path));
  if (!trees.has(repo) || "error" in trees.get(repo)!) await loadTree(repo, false);
  const tree = trees.get(repo);
  const files = tree && !("error" in tree) ? tree.files : null;
  // (the tree couldn't load: try to open it anyway)
  const found = !files ? path : files.includes(path) ? path : files.find((f) => f.toLowerCase() === path.toLowerCase());
  if (found) return goTo(url(found));
  const r = repoById(repo);
  const canCreate = !!r && !r.readOnly;
  toast(`No note at “${path}”`, "info", canCreate ? {
    label: "Create it",
    run: async () => {
      try {
        const res = await api.createFile(repo, path);
        await loadTree(repo, false);
        goTo(url(res.path));
      } catch (err) {
        toast(err instanceof ApiError && err.status === 409 ? `“${path}” already exists.` : errorMessage(err), "error");
      }
    },
  } : undefined);
}

/** Go to an /app URL (path, query, #heading) like the sidebar does; the same note only scrolls to the heading. */
function goTo(url: string) {
  const before = session;
  if (location.pathname + location.search + location.hash !== url) window.history.pushState(null, "", url);
  void route();
  const hash = new URL(url, location.href).hash;
  if (before && session === before && hash) before.scrollToHeading(decodeHash(hash));
}

function decodeHash(hash: string) {
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return hash.slice(1);
  }
}

// ---------- document ----------

/** The crash-recovery chunk (only loaded when a crashed session's edits are kept), retried a couple of times. */
async function importRecover(): Promise<typeof import("./editor-rs/recover.ts")> {
  for (let i = 0; ; i++) {
    try {
      return await import("./editor-rs/recover.ts");
    } catch (err) {
      if (i >= 2) throw err;
      await new Promise((r) => setTimeout(r, 300 * 2 ** i));
    }
  }
}

function copiedToast(ok: boolean) {
  toast(ok ? "Copied your unsaved text." : "Couldn't copy: select the text and copy it yourself.", ok ? "info" : "error");
}

/** A note renamed after its heading by this session: the next session of the new path picks up where it was. */
interface Carry {
  repo: string;
  path: string;
  sel: { anchor: number; head: number } | null;
  scroll: number;
  /** A still copy of the editor, shown until the new one mounts (no loading flash). */
  placeholder: HTMLElement;
}
let pendingCarry: Carry | null = null;

function openFile(repo: string, path: string) {
  if (session && session.repo === repo && session.path === path && !session.ended) return;
  closeSession();
  current = { repo, path };
  setWorkspace(repo);
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
  const carry = pendingCarry?.repo === repo && pendingCarry.path === path ? pendingCarry : null;
  pendingCarry = null;
  session = new Session(repo, path, carry);
  history.setTarget({ repo, path, readOnly: isRepoReadOnly(repo) });
  renderHeader();
}

function isRepoReadOnly(repoId: string) {
  const r = repoById(repoId);
  return !r || r.readOnly;
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
  const repo = writableRepoFor(wsId);
  const ws = repoById(wsId);
  clear(docBody, h("div", { class: "empty-state" },
    h("span", { class: "label" }, ws ? "Nothing open" : "Welcome"),
    h("h2", null, ws ? (ws.status === "importing" ? "Importing…" : "No note open.") : "Start a folder."),
    h("p", { class: "muted" }, ws ? "Pick a note from the sidebar, or start a new one." : "A folder holds Markdown notes you can share."),
    ws
      ? repo ? h("button", { type: "button", class: "btn btn-primary", onclick: () => void newNote(repo.id) }, "New note") : null
      : h("button", { type: "button", class: "btn btn-primary", onclick: () => newFolder() }, "New remote folder"),
  ));
}

function renderHeader() {
  historyBtn.disabled = !session;
  historyBtn.hidden = !session;
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
    h("button", { type: "button", class: "crumb crumb-repo", onclick: () => setSidebarOpen(true) }, repo?.title ?? repoId),
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
  for (const [, state] of session.peerStates()) {
    const u = validPeerUser((state as { user?: unknown } | null)?.user);
    if (u && !seen.has(u.id)) seen.set(u.id, u);
  }
  const users = [...seen.values()];
  clear(participantsEl, users.slice(0, 6).map((u) => {
    const el = avatar(u);
    if (u.self) el.title = signedIn ? `${u.name} (you)` : `${u.name} (you, not signed in)`;
    return el;
  }), users.length > 6 ? h("span", { class: "avatar avatar-more" }, `+${users.length - 6}`) : null);
}

function renderSaveStatus() {
  if (!session) return clear(saveStatusEl);
  const p = session.provider;
  let text: string | (string | HTMLElement)[];
  let cls = "";
  if (session.failed) {
    text = "Not editable — reload";
    cls = "warn";
  } else if (!p || p.status !== "connected") {
    if (session.everConnected) {
      text = session.readOnly ? "Offline" : "Offline — changes will sync when reconnected";
      cls = "warn";
    } else text = "Connecting…";
  } else if (session.readOnly) {
    // Read-only GitHub copies say so next to the breadcrumb.
    text = sourceEl.childElementCount ? "" : "Read-only";
  } else {
    // Notes save themselves a few seconds after you stop typing, so there's nothing to show while connected.
    text = "";
  }
  saveStatusEl.className = `save-status ${cls}`;
  clear(saveStatusEl, text);
  saveStatusEl.title = "";
}

/** Whether mounting the editor may take focus: not while the user is typing elsewhere or in a dialog. */
function mayFocusEditor() {
  if (document.querySelector("dialog[open]") || menuEl) return false;
  const a = document.activeElement;
  if (treeHasFocus) return false;
  return !a || a === document.body || docBody.contains(a);
}

class Session {
  /** The connection (the engine owns the note's shared document); null while the wasm loads, or if it can't. */
  provider: RustCollab | null = null;
  readonly localUser: PresenceState["user"];
  readonly host = h("div", { class: "editor-host" });
  private editor: EditorHandle | null = null;
  private fallback: (() => void) | null = null;
  /** Unsaved text from a crashed session that couldn't be merged, shown above the editor. */
  private banner: HTMLElement | null = null;
  /** Edits kept from a crashed session of this note (before the reload). */
  private kept: KeptEdits | null = null;
  everConnected = false;
  ended = false;
  /** The editor couldn't start or crashed: the note is shown read-only. */
  failed = false;

  constructor(
    readonly repo: string,
    readonly path: string,
    private carry: Carry | null = null,
  ) {
    this.localUser = { id: me.id, name: me.name, color: me.color ?? colorFor(me.id), kind: signedIn ? "human" : "guest", ...(me.avatar ? { avatar: me.avatar } : {}) };
    clear(docBody, carry ? carry.placeholder : h("div", { class: "loading" }, h("span", { class: "spinner" }), "Loading…"));
    // edits kept from a session whose engine crashed (before the reload): merged once this one is synced
    const kept = (this.kept = keptUnsent(me.id, repo, path));
    Promise.all([loadCollabEngine(), kept ? importRecover().catch((err: unknown) => (console.warn("The recovery code failed to load.", err), null)) : null]).then(
      ([factory, rec]) => {
        if (this.ended) return;
        if (kept && !rec) {
          // the saved edits stay where they are for the next load
          toast("Your unsaved edits from before the reload couldn't be restored yet.", "error");
          this.showUnsaved(kept, "Your unsaved edits from before the reload couldn't be restored (the page didn't load completely). They're kept: reload to try again.", true);
        }
        const recover = kept && rec ? new rec.UnsentEdits(kept) : undefined;
        // a guest joins with the made-up name and colour this browser keeps (the server counts their edits itself)
        const who: Record<string, string> = guest ? { anon: guest.id, name: guest.name, color: guest.color } : {};
        const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws?${new URLSearchParams({ repo, path, ...who })}`;
        this.connect(new RustCollab(factory, repo, path, this.localUser, { recover, url }));
      },
      (err) => {
        console.warn("The editor engine failed to load.", err);
        if (!this.ended) this.showReadOnly(null, COULDNT_START);
      },
    );
  }

  private connect(p: RustCollab) {
    const { repo, path } = this;
    this.provider = p;
    const ev: { on<K extends keyof CollabEvents>(type: K, fn: (...args: CollabEvents[K]) => void): () => void } = p;
    ev.on("synced", () => {
      if (session === this) saveLastNote(repo, path);
      this.mount();
    });
    ev.on("readOnly", () => {
      if (this.editor) this.mount();
      history.setTarget({ repo, path, readOnly: this.readOnly });
      renderSaveStatus();
    });
    ev.on("status", (s) => {
      if (s === "connected") this.everConnected = true;
      renderSaveStatus();
    });
    ev.on("saveState", () => renderSaveStatus());
    ev.on("awareness", () => renderParticipants());
    ev.on("crashed", (unsent) => this.crashed(unsent));
    ev.on("recovered", (ok, changed) => {
      const kept = this.kept;
      if (ok) {
        if (changed) toast("Your unsaved edits from before the reload were restored.");
        if (!kept?.older?.length) return forgetUnsent(me.id, repo, path);
        // an earlier crash's edits that couldn't be merged: kept only to be copied (nothing left to merge)
        const rest: KeptEdits = { generation: null, base: "", text: "", update: new Uint8Array(), older: kept.older };
        keepUnsent(me.id, repo, path, rest);
        this.kept = rest;
        this.showUnsaved(rest, "Unsaved edits from an earlier session of this note couldn't be merged. Copy them to redo the edits.", false);
        return;
      }
      // kept for the next load; meanwhile the text is offered to copy
      toast("Your unsaved edits from before the reload couldn't be restored.", "error");
      if (kept) this.showUnsaved(kept, "Your unsaved edits from before the reload couldn't be merged with the current note (it changed at the same places). Copy them to redo the edits.", false);
    });
    ev.on("reset", () => {
      if (session !== this) return;
      toast("This note was reloaded from the server.");
      closeSession();
      openFile(repo, path);
    });
    ev.on("closed", (reason, to) => this.onClosed(reason, to));
  }

  /**
   * The engine crashed: keep our edits of the session for the next load (merged after it syncs) and show the
   * note read-only with a Reload button.
   */
  private crashed(unsent: Uint8Array | null) {
    if (this.ended || session !== this) return;
    const text = this.editor?.text() ?? null;
    const p = this.provider;
    const base = p?.baseText ?? null;
    // nothing to keep if the session changed nothing (its edits, if any, cancel out)
    const changed = text !== null && base !== null && text !== base;
    // edits of an earlier crash still kept (not merged, not discarded) stay offered to copy
    const prev = keptUnsent(me.id, this.repo, this.path);
    const older = prev ? [...(prev.older ?? []), prev.text].filter(Boolean) : undefined;
    // without the update (unreadable) the text merge still works
    const kept: KeptEdits | null = changed ? { generation: p?.generation ?? null, base, text, update: unsent ?? new Uint8Array(), older } : null;
    const stored = !!kept && keepUnsent(me.id, this.repo, this.path, kept);
    if (kept && !stored) toast("The editor ran into a problem and your unsaved edits couldn't be kept: copy them before reloading.", "error");
    else toast(stored ? "The editor ran into a problem. Your unsaved edits are kept: reload to continue." : "The editor ran into a problem. Reload to continue.", "error");
    this.editor?.destroy();
    this.editor = null;
    this.provider?.destroy();
    this.provider = null;
    renderSaveStatus();
    renderParticipants();
    if (kept && !stored) this.showReadOnly(text, NOT_KEPT, unsavedActions(kept.text, this.fileName(), copiedToast));
    else this.showReadOnly(text, STOPPED);
  }

  /** The editor can't run: the note's Markdown read-only (`text`, or the server's copy) under a notice. */
  private showReadOnly(text: string | null, message: string, actions: { label: string; run: () => void }[] = []) {
    this.failed = true;
    renderSaveStatus();
    this.banner = null;
    this.host.replaceChildren();
    clear(docBody, this.host);
    const { repo, path } = this;
    this.fallback = showFallback(this.host, text ?? api.file(repo, path).then((r) => r.content, () => null), message, actions);
  }

  /**
   * Edits kept from a crashed session that couldn't be merged: a notice above the editor with their text to copy
   * or download (they stay kept for the next load until discarded); `retry`: offer a reload.
   */
  private showUnsaved(kept: KeptEdits, message: string, retry: boolean) {
    const { repo, path } = this;
    const text = [...(kept.older ?? []), kept.text].filter(Boolean).join("\n\n");
    const actions = unsavedActions(text, this.fileName(), copiedToast);
    if (retry) actions.push({ label: "Reload", run: () => location.reload() });
    actions.push({
      label: "Discard",
      run: () => {
        forgetUnsent(me.id, repo, path);
        this.banner?.remove();
        this.banner = null;
      },
    });
    this.banner = unsavedBanner(message, text, actions);
    if (this.editor) docBody.insertBefore(this.banner, this.host);
  }

  private fileName() {
    return this.path.split("/").pop() || "note.md";
  }

  get readOnly() {
    return this.provider?.readOnly ?? false;
  }

  /** The note's text as shown, or null before the editor is up. */
  text(): string | null {
    return this.editor?.text() ?? null;
  }

  /** Other participants' presence states. */
  peerStates(): [number, unknown][] {
    return this.provider?.peerStates() ?? [];
  }

  /** Focus the editor; false if it isn't up yet. */
  focus(): boolean {
    if (!this.editor) return false;
    this.editor.focus();
    return true;
  }

  flush() {
    if (this.readOnly || this.ended || !this.provider) return;
    this.provider.flush();
    if (this.provider.status !== "connected") toast("Offline — will save when reconnected.");
  }

  private mount() {
    if (this.ended) return;
    const focus = !this.editor && (mayFocusEditor() || focusNextEditor || !!this.carry);
    focusNextEditor = false;
    this.editor?.destroy();
    this.editor = null;
    this.host.replaceChildren();
    const demo = this.repo === DEMO_ID ? h("div", { class: "demo-banner", role: "note" }, "Demo folder — anyone can edit; it resets every few hours.") : null;
    clear(docBody, demo, this.banner, this.host);
    // relative image paths load from the notebook (the raw endpoint), resolved against the note's folder
    const images = repoImages(this.path, (p) => rawUrl(this.repo, p));
    // images dropped or pasted in go into the notebook next to the note
    const upload = {
      upload: async (file: File) => (await api.uploadImage(this.repo, this.path, file)).markdown,
      notice: (m: string, kind?: "info" | "error") => toast(m, kind),
    };
    this.editor = mountEditor(this.host, { collab: this.provider!, readOnly: this.readOnly, images, onLink: (t) => openLink(this, t), upload, onEnter: () => this.autoName() });
    if (focus) this.editor.focus();
    const carry = this.carry;
    this.carry = null;
    if (carry?.sel) this.editor.select(carry.sel.anchor, carry.sel.head);
    if (carry) docBody.scrollTop = carry.scroll;
    renderSaveStatus();
    // a link to a heading in this note (#fragment): once, when the note first shows
    if (!this.hashDone && location.hash.length > 1) this.scrollToHeading(decodeHash(location.hash));
    this.hashDone = true;
  }

  private hashDone = false;
  /** The path this session is renaming its note to (named after its heading). */
  private renamingTo: string | null = null;

  /**
   * Enter in an untitled note (Untitled.md, Untitled 2.md, …) whose first line is an H1, with the caret past that
   * line: rename the note after the heading, once (afterwards it isn't untitled). The server refuses if someone
   * else got there first.
   */
  autoName() {
    if (this.renamingTo || this.readOnly || this.ended || !isUntitledPath(this.path)) return;
    const text = this.editor?.text();
    const sel = this.editor?.selection();
    const firstLine = text?.indexOf("\n") ?? -1;
    if (!text || !sel || firstLine < 0 || sel.head <= firstLine) return;
    const tree = trees.get(this.repo);
    const to = autoNamePath(this.path, text, tree && !("error" in tree) ? tree.files : []);
    if (!to || to === this.path) return;
    this.renamingTo = to;
    api.rename(this.repo, this.path, to, true).then(
      () => void loadTree(this.repo),
      (err: unknown) => {
        // someone else named it first (their rename closes this note and moves everyone along): nothing to do
        if (!(err instanceof ApiError && err.status === 409)) {
          console.warn("auto-name:", err);
          this.renamingTo = null;
        }
      },
    );
  }

  scrollToHeading(fragment: string) {
    return this.editor?.scrollToHeading(fragment) ?? false;
  }

  private onClosed(reason: ClosedReason, to: string | undefined) {
    if (session !== this) return;
    const name = displayName(this.path);
    switch (reason) {
      case "renamed":
        if (to && to === this.renamingTo) {
          // our own rename after the heading: carry on in the renamed note where we were, without a flash
          const placeholder = this.host.cloneNode(true) as HTMLElement;
          for (const el of placeholder.querySelectorAll("[contenteditable]")) el.setAttribute("contenteditable", "false");
          pendingCarry = { repo: this.repo, path: to, sel: this.editor?.selection() ?? null, scroll: docBody.scrollTop, placeholder };
          closeSession();
          void loadTree(this.repo);
          return navigate(this.repo, to, true);
        }
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
        // signed out meanwhile: start again (as a guest)
        if (signedIn) location.reload();
        else this.notice("Couldn't open the note", "The server didn't accept this browser's guest name. Reload to try again.");
        return;
      case "forbidden":
        return this.notice("No access", "You don't have access to this note.");
      case "toolarge":
        return this.notice("File too large to open", `“${this.path}” is larger than 5 MB, too large to open as a note.`);
      case "notfound": {
        const repo = repoById(this.repo);
        const canCreate = repo && !repo.readOnly;
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
    this.fallback?.();
    this.provider?.destroy();
  }
}
