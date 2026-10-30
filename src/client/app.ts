// App shell: sidebar (repos, file tree, search files), document header, editor session, history, routing.
import { uiFontsLoaded } from "./fonts.ts";
import { mountEditor, repoImages, type EditorHandle, type LinkTarget } from "./editor-rs/index.ts";
import { loadCollabEngine, preloadWasm } from "./editor-rs/engine.ts";
import { warmCode } from "./editor-rs/code.ts";
import { RustCollab, type ClosedReason, type CollabEvents } from "./editor-rs/collab.ts";
import { COULDNT_START, NOT_KEPT, STOPPED, showFallback, unsavedActions, unsavedBanner } from "./editor-rs/fallback.ts";
import { forgetAllUnsent, forgetUnsent, keepUnsent, keptUnsent, type KeptEdits } from "./editor-rs/unsent.ts";
import { forgetImageSizes } from "./editor-rs/render.ts";
import { api, ApiError, setGuest, subscribeEvents, type AppEvent, type EventSubscription, type Config, type Me, type PresenceUserInfo, type Repo, type ServerInfo, type Tree, type Workspace } from "./api.ts";
import { anonIdentity, setAnonName, signInDialog, signInDirect, type AnonIdentity, type SignInReason } from "./signin.ts";
import { renderScratch } from "./scratch.ts";
import { HistoryPanel } from "./history.ts";

import { agentPrompt, confirmDialog, copyText, promptDialog } from "./dialogs.ts";
import { openFileSearch } from "./filesearch.ts";
import { hostOf, newDialog, openDialog, type OpenChoice, type WorkspaceRef, forgetAllRemotes, forgetRemote, rememberedRemotes, rememberRemote, workspaceUrl } from "./workspaces.ts";
import { demoResetPhrase } from "../shared/demo.ts";
import { githubFileUrl } from "../shared/github.ts";
import { autoNamePath, isUntitledPath, untitledPath } from "../shared/untitled.ts";
import { NoteCache } from "./notecache.ts";
import { NoteSocket } from "./notesocket.ts";
import type { WorkspaceEventMsg } from "../shared/wsmux.ts";
import { avatar, clear, colorFor, displayName, errorMessage, h, pickNote, toast, validPeerUser } from "./util.ts";
import type { PresenceState } from "../shared/presence.ts";

// ---------- state ----------

// the editor engine's wasm loads while the app starts
preloadWasm();

let config: Config;
let server: ServerInfo;
let me: Me;
/**
 * Signed in (an account). Otherwise a guest: no account, a made-up name (`guest`); guests edit notes, but creating,
 * renaming and deleting notes and folders, images and workspaces need an account (except in the demo: `guestCreate`).
 */
let signedIn = false;
/**
 * The server has no accounts (/api/config `signIn: false`): no sign-in anywhere; this browser's guest identity may do
 * everything an account may (`signedIn` is true too), and "Change name…" renames that identity.
 */
let noSignIn = false;
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
/** Protocol v2 (the server's /api/server `ws` has 2): the selected workspace's socket carries its notes and events. */
let noteSocket: NoteSocket | null = null;
/** Older servers: the event stream, for the workspaces in the list. */
let eventSub: EventSubscription | null = null;

/** The demo folder (the server keeps it in memory and resets it every DEMO_RESET_MINUTES). */
const DEMO_ID = "demo";
const fkey = (repo: string, path: string) => `${repo}\u0000${path}`;
const dirKey = (repo: string, path: string) => `dir:${fkey(repo, path)}`;
const repoById = (id: string | null) => (id ? repos.find((r) => r.id === id) : undefined);
const MD_EXT = /\.(md|markdown|mdx)$/i;
const TREE_STATE_KEY = "grimoire.tree.v2";
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
// The note last opened, per user: /app reopens it.
const LAST_NOTE_KEY = "grimoire.lastNote.v1";
// The note last opened in each workspace: switching to a workspace reopens it.
const LAST_BY_WS_KEY = "grimoire.lastNoteByWorkspace.v1";

// ---------- first load ----------
// The app stays behind the HTML's splash (#splash, index.html) until its first view is complete: who I am, the
// workspace list, the tree, the open note's text (or the reason it can't show), the editor engine and the fonts.
// Then the splash goes and everything shows in one frame. After BOOT_CAP_MS it shows with whatever is ready.
// The requests for that view start here, at once and in parallel (config, server and me are preloaded by the HTML);
// the code that needs one takes it (take()) instead of asking again.

const BOOT_CAP_MS = 3000;
const early = new Map<string, { p: Promise<unknown>; at: number }>();
/** An early request not taken within this long is stale: asked again. */
const EARLY_MS = 10_000;
let revealed = false;
let bootCapped = false;
let shellUp = false;
/** The first route has decided what opens (until then nothing says "No workspace"). */
let routed = false;

function prefetchEarly<T>(key: string, run: () => Promise<T>) {
  const e = early.get(key);
  if (e && performance.now() - e.at < EARLY_MS) return;
  const p = run();
  p.catch(() => {});
  early.set(key, { p, at: performance.now() });
}

/** The first load's request for `key` (once), else a new one. */
function take<T>(key: string, run: () => Promise<T>): Promise<T> {
  const e = early.get(key);
  early.delete(key);
  return e && performance.now() - e.at < EARLY_MS ? (e.p as Promise<T>) : run();
}

/** A stored "last note" without checking whose it is (only a guess at what /app opens, to fetch it early). */
function storedNote(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function startBootRequests() {
  // this browser's guest identity goes with every request from the start (the server only uses it for visitors, or
  // everyone on a server without sign-in, whose early requests must already be theirs); signed in, dropped at boot
  setGuest(anonIdentity());
  prefetchEarly("config", api.config);
  prefetchEarly("server", api.server);
  prefetchEarly("me", api.me);
  if (!isAppPath(location.pathname)) return;
  prefetchEarly("repos", api.repos);
  const r = parseRoute();
  const last = storedNote(LAST_NOTE_KEY) as { repo?: unknown; path?: unknown } | null;
  const repo = r?.repo ?? (typeof last?.repo === "string" ? last.repo : null);
  // (the demo's room is asked for first: route())
  if (!repo || repo === DEMO_ID) return;
  prefetchEarly(`repo:${repo}`, () => api.repo(repo));
  prefetchEarly(`tree:${repo}`, () => api.tree(repo));
  const byWs = (storedNote(LAST_BY_WS_KEY) as { notes?: Record<string, unknown> } | null)?.notes?.[repo];
  const path = r ? r.path ?? (typeof byWs === "string" ? byWs : null) : typeof last?.path === "string" ? last.path : null;
  if (path) prefetchEarly(`file:${fkey(repo, path)}`, () => api.file(repo, path));
}

startBootRequests();
window.setTimeout(() => {
  bootCapped = true;
  if (shellUp) reveal();
}, Math.max(0, BOOT_CAP_MS - performance.now()));

/** Take the splash away: what's in #app shows, all at once. */
function reveal() {
  if (revealed) return;
  revealed = true;
  if (treeFrame) flushTree();
  document.getElementById("splash")?.remove();
  app.removeAttribute("aria-busy");
  performance.mark("grimoire:app");
}

/** Everything the first view shows is in place (or failed and says so); capped by BOOT_CAP_MS. */
async function firstViewReady() {
  const sheets = [...document.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet]")].map((l) =>
    l.sheet ? null : new Promise((done) => (l.addEventListener("load", done), l.addEventListener("error", done))),
  );
  const fonts = uiFontsLoaded;
  const engine = loadCollabEngine().catch(() => {});
  // the open note: until its text shows (preview or live) or the note says why it can't
  for (;;) {
    const s = session;
    if (!s) break;
    await s.shown;
    if (s === session) break;
  }
  // the open workspace's tree
  const ws = wsId;
  if (ws && !trees.has(ws) && repoById(ws)?.status === "ready") await (treeLoads.get(ws)?.catch(() => {}) ?? loadTree(ws));
  const text = session?.shownText() ?? "";
  await Promise.all([...sheets, fonts, engine, /^ {0,3}(```|~~~)/m.test(text) ? warmCode() : null]);
  // after a layout of it all: the font faces its characters asked for, and the images the note shows (their size
  // moves the text below them)
  await new Promise((r) => requestAnimationFrame(r));
  await Promise.all([document.fonts.ready, ...[...docBody.querySelectorAll("img")].map((img) => img.decode().catch(() => {}))]);
}

// ---------- elements ----------

const app = document.getElementById("app")!;
const treeEl = h("nav", { class: "sb-tree", "aria-label": "Files" });
/** Looks like a field; opens the "Search files" dialog (Ctrl+P). */
const searchBtn = h("button", { type: "button", class: "sb-search", "aria-haspopup": "dialog", "aria-keyshortcuts": "Control+P", onclick: () => void searchFiles() },
  h("span", { class: "sb-search-label" }, "Search files"), h("kbd", { "aria-hidden": "true" }, "Ctrl P"));
const agentCopyBtn = h("button", { type: "button", class: "btn btn-small", onclick: () => void copyAgentPrompt() }, "Copy") as HTMLButtonElement;
/** Pinned below the tree: copies the open folder's agent instructions (with my agent link for it). */
const agentCard = h("div", { class: "sb-agent", hidden: true }, h("span", { class: "sb-agent-label" }, "Share this workspace with an agent"), agentCopyBtn);
/** The very bottom of the sidebar: who's signed in; opens the account menu (upward). */
const accountBtn = h("button", { type: "button", class: "sb-account", "aria-haspopup": "menu", "aria-expanded": "false" });
const breadcrumbEl = h("div", { class: "breadcrumb" });
const sourceEl = h("div", { class: "doc-source" });
const participantsEl = h("div", { class: "participants" });
const saveStatusEl = h("div", { class: "save-status", "aria-live": "polite" });
/** Line authors in the editor's margin, on unless turned off in this browser. */
const SHOW_AUTHORS_KEY = "grimoire.showAuthors";
/** The header's "⋯": History, Authors, the open note's Rename / Delete and Copy Link. */
const moreBtn = h("button", { type: "button", class: "icon-btn doc-more", title: "More", "aria-label": "More actions", "aria-haspopup": "menu", "aria-expanded": "false", hidden: true }, "⋯");
const docBody = h("div", { class: "doc-body" });
const history = new HistoryPanel((open) => app.classList.toggle("history-open", open));
const switcherBtn = h("button", { type: "button", class: "ws-switcher", "aria-haspopup": "menu", "aria-expanded": "false" });
const newNoteBtn = h("button", { type: "button", class: "quiet-btn new-note", onclick: () => void newNote() }, h("span", { class: "plus", "aria-hidden": "true" }), "New note");
let menuEl: HTMLElement | null = null;
let menuOpener: HTMLElement | null = null;
let menuOpenerKey: string | null = null;

// ---------- boot ----------

void boot();

async function boot() {
  try {
    [config, server] = await Promise.all([take("config", api.config), take("server", api.server)]);
  } catch (err) {
    clear(app, h("div", { class: "fatal" }, "Couldn't reach the server: ", errorMessage(err)));
    return reveal();
  }
  // Old note links (/r/...) live under /app now; the server redirects full page loads, this covers the rest.
  if (/^\/r(\/|$)/.test(location.pathname)) window.history.replaceState(null, "", "/app" + location.pathname.slice(2) + location.search + location.hash);
  // The landing page (with its pencils, src/client/landing) is only on our hosted site (MARKETING_SITE); elsewhere
  // "/" is the app, and the landing code is never fetched. On, it starts loading now, while /api/me is asked.
  if (!config.marketing && location.pathname === "/") window.history.replaceState(null, "", "/app" + location.search + location.hash);
  const onApp = isAppPath(location.pathname);
  const landing = config.marketing && location.pathname === "/" ? import("./landing/home.ts") : null;
  const showLanding = (signed: boolean) =>
    void landing!
      .then((m) => m.renderHome(app, config, server, signed))
      .catch((err) => clear(app, h("div", { class: "fatal" }, errorMessage(err))))
      .finally(reveal);
  // the scratch note needs nothing from the server (and no account)
  if (location.pathname === "/scratch") return void (renderScratch(app), reveal());
  if (config.signIn === false) {
    // no accounts here: everyone may do everything, as this browser's guest identity (no sign-in UI anywhere)
    noSignIn = true;
    signedIn = true;
    guest = anonIdentity();
    setGuest(guest);
    switchAccountData("guest");
    me = { id: `guest:${guest.id}`, login: "", name: guest.name, email: "", avatar: null, color: guest.color };
    if (onApp) prefetchEarly("workspaces", api.workspaces);
  } else try {
    me = await take("me", api.me);
    setGuest(null);
    signedIn = true;
    // just signed in after browsing as a guest: what this browser opened joins the account's list (kept on any
    // device); after another account, nothing of that one carries over
    if (switchAccountData(me.id) !== "other") await mergeVisited();
    if (onApp) prefetchEarly("workspaces", api.workspaces);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) {
      clear(app, h("div", { class: "fatal" }, errorMessage(err)));
      return reveal();
    }
    if (landing) return showLanding(false);
    // Not signed in: a guest, without an account. Others see my made-up name on my cursor and my commits.
    guest = anonIdentity();
    setGuest(guest);
    // signed out (the session ended): the account's data goes
    switchAccountData("guest");
    me = { id: `guest:${guest.id}`, login: "", name: guest.name, email: "", avatar: null, color: guest.color };
  }
  if (landing) return showLanding(signedIn);
  loadTreeState();
  renderShell();
  shellUp = true;
  if (bootCapped) reveal();
  if (server.ws?.includes(2)) {
    noteSocket = new NoteSocket({
      query: guestQuery,
      user: localUser,
      onEvent: onSocketEvent,
      // missed events while away (the presence snapshot follows the welcome)
      onWelcome: (_repo, _w, reconnect) => reconnect && void loadRepos(true),
      // my demo room went (or is full for me now): ask for one again
      onClose: (repo, code) => {
        if (!isDemoRoom(repo) || (code !== 4404 && code !== 4409) || repo !== wsId) return;
        demoRoom = null;
        void route();
      },
    });
  } else {
    eventSub = subscribeEvents(() => repos.map((r) => r.id), onEvent, (reconnect) => {
      // The server sends a presence snapshot on every connect.
      presence.clear();
      renderTree();
      if (reconnect) void loadRepos(true);
    });
  }
  await loadRepos();
  await route();
  routed = true;
  renderSwitcher();
  renderTree();
  resumeAfterSignIn();
  window.addEventListener("popstate", () => void route());
  setInterval(renderSaveStatus, 30_000);
  await firstViewReady();
  reveal();
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
    if (!signedIn) {
      // "Sign in": straight to Google
      if (!signInDirect(config, server)) openSignIn(null);
      return;
    }
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

  moreBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menuEl && menuOpener === moreBtn) return closeMenu();
    showMenu(moreBtn, noteMenu(), { keepOrder: true, alignRight: true });
  });
  setShowAuthors(showAuthors());

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
        searchBtn,
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
        breadcrumbEl, sourceEl, h("div", { class: "spacer" }), saveStatusEl, participantsEl, moreBtn,
      ),
      docBody,
    ),
    history.el,
  );

  document.addEventListener("keydown", (e) => {
    // Notes save themselves; Cmd/Ctrl-S just shouldn't open the browser's "Save page" dialog.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") e.preventDefault();
    // Ctrl+P (on every platform; not the browser's Print): Search files.
    if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.code === "KeyP") {
      e.preventDefault();
      e.stopPropagation();
      if (document.querySelector("dialog[open]:not(.fs-modal)")) return;
      closeMenu();
      void searchFiles();
      return;
    }
    // ⌘⇧E (Ctrl+Shift+E elsewhere): the file tree, at the current row, from anywhere.
    if ((IS_MAC ? e.metaKey : e.ctrlKey) && e.shiftKey && !e.altKey && e.code === "KeyE") {
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      focusTree();
    }
  }, true);
  document.addEventListener("keydown", bufferTypedAhead, true);
  // a click elsewhere: whatever was typed ahead wasn't meant for the new note anymore
  document.addEventListener("mousedown", (e) => {
    if (typedAhead && !(e.target as HTMLElement).closest?.(".menu")) typedAhead.until = 0;
  }, true);
  document.addEventListener("click", () => closeMenu());
  window.addEventListener("blur", () => closeMenu());
}

function setSidebarOpen(open: boolean) {
  app.classList.toggle("sidebar-open", open);
  app.querySelector(".sidebar-toggle")?.setAttribute("aria-expanded", String(open));
}

async function changeName() {
  const name = await promptDialog({ title: "Change name", label: "Name", value: me.name, submit: "Save", hint: "Shown on your cursor and on your commits." });
  if (!name?.trim() || name.trim() === me.name) return;
  if (noSignIn) {
    // no account: the name is this browser's (sent with every request and socket)
    const err = setAnonName(name);
    if (err) return toast(err, "error");
    return location.reload();
  }
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
  forgetAccountData(me.id);
  try {
    localStorage.setItem(ACCOUNT_KEY, "guest");
    // and the remote workspaces this browser listed (on other servers): signed out, no remote workspace stays in view
    forgetAllRemotes();
  } catch {}
  location.href = "/";
}

// ---------- workspace switcher ----------

const joinedById = (id: string | null) => (id ? workspaces.find((w) => w.id === id) : undefined);

function workspaceTitle(id: string | null) {
  return joinedById(id)?.title ?? repoById(id)?.title ?? id ?? (routed ? "No workspace" : "");
}

function renderSwitcher() {
  const title = workspaceTitle(wsId);
  clear(switcherBtn,
    h("span", { class: "ws-mark", "aria-hidden": "true" }, (title.trim()[0] ?? "?").toUpperCase()),
    h("span", { class: "ws-text" }, h("span", { class: "ws-title" }, title), h("span", { class: "ws-host" }, location.host)),
    h("span", { class: "chev chev-down", "aria-hidden": "true" }),
  );
  switcherBtn.title = `${title} · ${location.host}`;
  switcherBtn.setAttribute("aria-label", `${title} on ${location.host}. Switch workspace`);
  newNoteBtn.hidden = !writableRepoFor(wsId);
  const ws = repoById(wsId);
  // handing a folder to an agent is for people who are signed in: guests don't see it at all
  agentCard.hidden = !signedIn || ws?.status !== "ready";
}

/** The switcher's order: case-insensitive natural order, ties by id, so it never depends on which folder is open. */
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

async function openSwitcher() {
  // v2: no /api/events stream tells about other workspaces; refresh the list for next time
  if (noteSocket && signedIn) void api.workspaces().then((w) => (workspaces = w), () => {});
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
      host === here && !list.length ? { label: "No workspaces yet", run: () => newFolder(), disabled: true } : null,
    ]),
    "sep",
    { label: "New…", run: () => newFolder() },
    { label: "Open…", run: () => openFolder() },
    ws ? "sep" : null,
    ws?.kind === "github" && ws.ghOwner ? { label: "Open on GitHub", run: () => window.open(`https://github.com/${ws.ghOwner}/${ws.ghName}`, "_blank", "noopener") } : null,
  ];
  showMenu(switcherBtn, items, { keepOrder: true, className: "ws-menu" });
}

/** My email, unless it's an old name sign-in's made-up one (@dev.grimoire; @localhost before that). */
const myEmail = () => (me.email && !/@(localhost|dev\.grimoire)$/.test(me.email) ? me.email : "");

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
  if (noSignIn) {
    accountBtn.title = `${me.name} · ${location.host} has no sign-in`;
    accountBtn.setAttribute("aria-label", `${me.name}, no sign-in on ${location.host}. Change name`);
    return;
  }
  accountBtn.title = myEmail() ? `${me.name} · ${myEmail()}` : me.name;
  accountBtn.setAttribute("aria-label", `Signed in as ${me.name}. Account`);
}

/** The account row's menu, opening upward: my email, Change name…, Sign out. */
function openAccountMenu() {
  if (noSignIn) return showMenu(accountBtn, [{ section: `${location.host} · No sign-in` }, { label: "Change name…", run: changeName }], { keepOrder: true, above: true, className: "account-menu" });
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

/** Signed in, true; else the sign-in dialog (creating folders needs an account) and false. */
function requireAccount(): boolean {
  if (signedIn) return true;
  openSignIn("folders");
  return false;
}

function openSignIn(reason: SignInReason) {
  closeMenu(false);
  const scratch = current ? `/scratch?${new URLSearchParams({ from: `${current.repo}/${current.path}` })}` : "/scratch";
  // guests not in the demo folder are pointed at it too
  return signInDialog(config, server, { reason, scratch, demo: !signedIn && !isDemoRoom(wsId) });
}

/** Guests create, rename, delete and upload only in workspaces open to guests (the demo); people signed in anywhere. */
function canCreateIn(repo: Repo | null | undefined): boolean {
  return signedIn || !!repo?.guestCreate;
}

/** What a guest tried that needs an account: done once they've signed in (`AFTER_SIGN_IN`). */
interface AfterSignIn {
  kind: "newNote" | "newFolder" | "rename" | "renameFolder" | "delete" | "deleteFolder";
  /** Where new notes and folders go ("" at the top; undefined: the open note's folder). */
  dir?: string;
  /** The note or folder to rename or delete. */
  path?: string;
}
const AFTER_SIGN_IN = "grimoire.afterSignIn.v1";
const AFTER_SIGN_IN_MS = 15 * 60_000;
const SIGN_IN_REASON: Record<AfterSignIn["kind"], SignInReason> = { newNote: "create", newFolder: "create", rename: "rename", renameFolder: "rename", delete: "delete", deleteFolder: "delete" };

/**
 * May this go ahead in `repo`? Signed in (or in the demo), yes. A guest gets the sign-in dialog instead, and `action`
 * is remembered for this tab so it happens once they're back signed in (closing the dialog forgets it).
 */
function signedInFor(repo: Repo | null | undefined, action: AfterSignIn | null, reason?: SignInReason): boolean {
  if (canCreateIn(repo)) return true;
  const dlg = openSignIn(reason ?? SIGN_IN_REASON[action!.kind]);
  const saved = action && repo ? JSON.stringify({ ...action, repo: repo.id, at: Date.now() }) : null;
  try {
    if (saved) sessionStorage.setItem(AFTER_SIGN_IN, saved);
    else sessionStorage.removeItem(AFTER_SIGN_IN);
  } catch {}
  // (an earlier dialog's close event can come after this one opened: only forget our own action)
  dlg.addEventListener("close", () => {
    try {
      if (saved && sessionStorage.getItem(AFTER_SIGN_IN) === saved) sessionStorage.removeItem(AFTER_SIGN_IN);
    } catch {}
  });
  return false;
}

/** Back from signing in: carry on with what the guest tried (a new note, a rename…) if it's still possible. */
function resumeAfterSignIn() {
  let a: (AfterSignIn & { repo: string; at: number }) | null = null;
  try {
    a = JSON.parse(sessionStorage.getItem(AFTER_SIGN_IN) ?? "null");
    sessionStorage.removeItem(AFTER_SIGN_IN);
  } catch {}
  if (!a || !signedIn || !(Date.now() - a.at < AFTER_SIGN_IN_MS)) return;
  const repo = repoById(a.repo);
  if (!repo || repo.readOnly || a.repo !== wsId) return;
  const tree = trees.get(repo.id);
  const files = tree && !("error" in tree) ? tree.files : [];
  const path = a.path ?? "";
  const isFile = files.includes(path);
  const isDir = files.some((f) => f.startsWith(`${path}/`));
  switch (a.kind) {
    case "newNote":
      return void newNote(repo.id, a.dir);
    case "newFolder":
      return void newSubfolder(repo, a.dir ?? "");
    case "rename":
      return isFile ? renameNoteInline(repo, path) : undefined;
    case "renameFolder":
      return isDir ? renameFolderInline(repo, path) : undefined;
    case "delete":
      return isFile ? void deleteFile(repo, path) : undefined;
    case "deleteFolder":
      return isDir ? void deleteFolder(repo, path) : undefined;
  }
}

/**
 * The switcher's ×: asks first ("Remove <name> from your list?"), then `remove`. The only folder in the list can't
 * go: a dialog says to make another one first.
 */
async function removeFromList(name: string, rows: number, remove: () => void) {
  closeMenu(false);
  if (rows <= 1) {
    const make = await confirmDialog({ title: "Can't remove your only workspace", message: "You can't remove the only workspace in your list. Create a new workspace first, then remove this one.", confirm: "New workspace…", cancel: "OK" });
    if (make) newFolder();
    return;
  }
  const ok = await confirmDialog({ title: `Remove ${name} from your list?`, message: "This doesn't delete the workspace. All existing links to it keep working, and if you open a link to it again, it'll come back to your list.", confirm: "Remove" });
  if (ok) remove();
}

// The folders a guest opened, remembered in this browser (their switcher's list; × takes one off).
const VISITED_KEY = "grimoire.visited.v1";

function visited(): Workspace[] {
  try {
    const raw = JSON.parse(localStorage.getItem(VISITED_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((w): w is Workspace => !!w && typeof w.id === "string" && !isDemoRoom(w.id) && typeof w.title === "string" && (w.kind === "notes" || w.kind === "github"));
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

// Whose data this browser keeps ("guest" or a user id). Another account signing in, or signing out, clears the
// previous account's: its last notes, folders' open state, folded headings, image sizes and kept edits; the
// workspace list then comes from the new account (docs/accounts.md). The scratch note (this browser's own) stays.
const ACCOUNT_KEY = "grimoire.account.v1";

function forgetAccountData(user: string | null) {
  if (user) forgetAllUnsent(user);
  forgetImageSizes();
  try {
    for (const k of [VISITED_KEY, TREE_STATE_KEY, LAST_NOTE_KEY, LAST_BY_WS_KEY]) localStorage.removeItem(k);
    const folds: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith("grimoire.folds:") && k.includes("\u0000")) folds.push(k);
    }
    for (const k of folds) localStorage.removeItem(k);
  } catch {}
}

/** Who this browser's data belonged to, and now belongs to `who` ("guest" or a user id). */
function switchAccountData(who: string): "same" | "from-guest" | "other" {
  let prev: string | null = null;
  try {
    prev = localStorage.getItem(ACCOUNT_KEY);
    localStorage.setItem(ACCOUNT_KEY, who);
  } catch {}
  if (prev === who) return "same";
  if (!prev || prev === "guest") return "from-guest";
  forgetAccountData(prev);
  return "other";
}

/** Signed in with workspaces opened as a guest in this browser: add them to the account, then forget them here. */
async function mergeVisited() {
  // (never the demo: it's for people who aren't signed in)
  const ids = visited().map((w) => w.id).filter((id) => id !== DEMO_ID);
  if (!ids.length) return;
  try {
    await api.joinMany(ids.slice(0, 200));
    localStorage.removeItem(VISITED_KEY);
  } catch {
    // kept for the next sign-in check
  }
}

function forgetVisited(id: string) {
  try {
    localStorage.setItem(VISITED_KEY, JSON.stringify(visited().filter((w) => w.id !== id)));
  } catch {}
  forgetLastNote(id);
}

/** "Open…": open a folder by name or URL (anyone: all folders are public), or add a GitHub repo (signed in). */
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
  }, start, { github: signedIn });
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
      take("repos", api.repos),
      signedIn ? take("workspaces", api.workspaces).catch((err: unknown) => (console.warn("workspaces:", err), workspaces)) : Promise.resolve(visited()),
    ]);
    // the open workspace stays known even if it isn't listed (e.g. opened before its join was recorded)
    const open = repoById(wsId);
    repos = open && !r.some((x) => x.id === open.id) ? [...r, open] : r;
    workspaces = w;
    eventSub?.update();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return location.reload();
    toast(`Couldn't load workspaces: ${errorMessage(err)}`, "error");
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
}

/** Tree requests in flight, by workspace (the first view waits for its tree). */
const treeLoads = new Map<string, Promise<unknown>>();

async function loadTree(id: string, render = true) {
  try {
    const req = take(`tree:${id}`, () => api.tree(id));
    treeLoads.set(id, req);
    void req.catch(() => {}).finally(() => treeLoads.get(id) === req && treeLoads.delete(id));
    const tree = await req;
    trees.set(id, tree);
    folderCache.set(id, buildFolders(tree.files));
  } catch (err) {
    trees.set(id, { error: errorMessage(err) });
    folderCache.delete(id);
  }
  if (render) renderTree();
}

/** A workspace event on its socket (v2), as the /api/events stream would have sent it. */
function onSocketEvent(repo: string, e: WorkspaceEventMsg) {
  switch (e.t) {
    case "tree":
      return onEvent({ type: "tree", repo });
    case "presence":
      if ("files" in e) {
        // the snapshot after every welcome: this workspace's presence, all of it
        for (const k of [...presence.keys()]) if (k.startsWith(fkey(repo, ""))) presence.delete(k);
        for (const f of e.files) onEvent({ type: "presence", repo, path: f.path, users: f.users });
        return renderTree();
      }
      return onEvent({ type: "presence", repo, path: e.path, users: e.users });
    case "saved":
      return onEvent({ type: "saved", repo, path: e.path, sha: e.sha });
    case "workspace":
      // import status or title: the workspace list says
      return void loadRepos(e.status === "ready");
  }
}

/** A guest's made-up identity, for the socket URL. */
function guestQuery(): Record<string, string> {
  return guest ? { anon: guest.id, name: guest.name, color: guest.color } : {};
}

/** Our presence user (cursor labels, participants). */
function localUser(): PresenceState["user"] {
  return { id: me.id, name: me.name, color: me.color ?? colorFor(me.id), kind: signedIn && !noSignIn ? "human" : "guest", ...(me.avatar ? { avatar: me.avatar } : {}) };
}

/** Ids of the people (not me) in a file, for telling whether its presence dots changed. */
function peerSignature(users: PresenceUserInfo[] | undefined) {
  return (users ?? []).filter((u) => u.id !== me.id).map((u) => `${u.id}:${u.color}:${u.kind}`).sort().join(",");
}

function onEvent(e: AppEvent) {
  switch (e.type) {
    case "tree":
      if (trees.has(e.repo)) void loadTree(e.repo);
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
  /** The row menu's Delete (with its confirm), when allowed: whether it was deleted. */
  remove?: () => Promise<boolean>;
}
const rowActions = new WeakMap<HTMLElement, RowActions>();
let groupSeq = 0;

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
  // Re-rendering replaces the rows; keep keyboard focus on the same row.
  const active = document.activeElement as HTMLElement | null;
  const focusKey = treeEl.contains(active) ? active?.closest<HTMLElement>("[data-key]")?.dataset.key : undefined;
  groupSeq = 0;
  const ws = repoById(wsId);
  const renaming = !!inlineRename && active === inlineRename.input;
  treeRendering = true;
  try {
    if (!ws) {
      clear(treeEl, wsId || !routed ? null : h("div", { class: "sb-empty" }, h("p", null, "No workspaces yet."), h("button", { class: "btn", type: "button", onclick: () => newFolder() }, "New workspace")));
    } else {
      clear(treeEl, renderWorkspaceTree(ws));
    }
  } finally {
    treeRendering = false;
  }
  applyRoving();
  if (renaming && inlineRename?.input.isConnected) {
    inlineRename.input.focus({ preventScroll: true });
    treeEl.scrollTop = scroll;
    return;
  }
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
  // (the open note by its key: its row's aria-current may not be re-rendered yet)
  if (!row.classList.contains("file-row") || (current && row.dataset.key === `file:${fkey(current.repo, current.path)}`)) return;
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
  if (row.getAttribute?.("role") !== "treeitem") return;
  // Backspace (the Mac's delete key), forward Delete, ⌘⌫ / Ctrl+Backspace: the row menu's Delete
  if ((e.key === "Backspace" || e.key === "Delete") && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    void deleteRow(row);
    return;
  }
  if (e.altKey || e.metaKey || e.ctrlKey) return;
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
      if (expanded === "true") acts?.setOpen?.(false);
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
      showMenu(row, acts?.menu() ?? [], { keepOrder: true });
      break;
    case "ContextMenu":
      showMenu(row, acts?.menu() ?? [], { keepOrder: true });
      break;
    default:
      if (e.key.length === 1 && e.key !== "/" && e.key !== " ") typeAheadKey(e.key, rows, i);
      else handled = false;
  }
  if (handled) e.preventDefault();
}

/**
 * Delete a tree row's note or folder (its menu's Delete, or Backspace / Delete / ⌘⌫ on it), after the confirm; nothing
 * where the menu has no Delete, e.g. read-only. Then the row after it gets focus (the one before it, if it was the
 * last), so you can keep going; cancelled, the row keeps it.
 */
/** The row menu's Delete: as from the keyboard, on the row as it is now (the tree may have re-rendered). */
function deleteRowByKey(key: string) {
  const row = visibleRows().find((r) => r.dataset.key === key);
  if (row) return deleteRow(row);
}

async function deleteRow(row: HTMLElement) {
  const remove = rowActions.get(row)?.remove;
  if (!remove || inlineRename) return;
  const rows = visibleRows();
  const i = rows.indexOf(row);
  const li = row.closest("li");
  // (not a row inside a folder being deleted)
  const after = rows.slice(i + 1).find((r) => !li?.contains(r)) ?? rows.slice(0, i).reverse().find((r) => !li?.contains(r));
  const key = row.dataset.key;
  const nextKey = after?.dataset.key ?? null;
  // (the open note, or a folder holding it)
  const open = current ? `file:${fkey(current.repo, current.path)}` : null;
  const wasOpen = !!open && (open === key || (!!li && [...li.querySelectorAll<HTMLElement>("[data-key]")].some((r) => r.dataset.key === open)));
  // the open note's room closes ("deleted") when the server deletes it, maybe before or after the reply: we open
  // the next note ourselves, so its session mustn't go to the workspace's first note
  const opened = current;
  if (wasOpen && opened) deletingOpen = { ...opened, until: performance.now() + 15_000 };
  const deleted = await remove();
  if (!deleted && deletingOpen?.path === opened?.path) deletingOpen = null;
  const want = deleted ? nextKey : key;
  if (deleted) treeFocusKey = want ?? null;
  // the tree may have re-rendered: find the row again by its key
  const target = visibleRows().find((r) => r.dataset.key === want) ?? (deleted ? visibleRows()[Math.min(i, visibleRows().length - 1)] : undefined);
  // the open note went: the note that gets focus opens (not the workspace's first note; with no note to go to, home)
  if (deleted && wasOpen) {
    if (target?.classList.contains("file-row")) return moveTo(target);
    if (opened && current?.path === opened.path && current.repo === opened.repo) goHome(true);
  }
  if (target && target !== document.activeElement) focusRow(target);
}

/** The open note while the tree deletes it (deleteRow), so its session's "deleted" close doesn't navigate. */
let deletingOpen: { repo: string; path: string; until: number } | null = null;

function bindRow(el: HTMLElement, acts: RowActions) {
  rowActions.set(el, acts);
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showMenu({ x: e.clientX, y: e.clientY }, acts.menu(), { opener: el, keepOrder: true });
  });
}

function chevron() {
  return h("span", { class: "chev", "aria-hidden": "true" });
}

/** A row's "⋯" button. It sits next to the row (not inside it) so the row stays a single focusable item. */
function menuButton(rowKey: string, label: string, items: () => MenuItem[]) {
  return h("button", {
    type: "button", class: "icon-btn row-menu", tabindex: "-1", title: "More", "aria-label": label, "aria-haspopup": "menu", "aria-expanded": "false", "data-for": rowKey,
    onclick: (e: MouseEvent) => (e.preventDefault(), e.stopPropagation(), showMenu(e.currentTarget as HTMLElement, items(), { keepOrder: true })),
  }, "⋯");
}

/** A child group, owned by its row for assistive tech. */
function group(row: HTMLElement, ul: HTMLElement) {
  ul.id = `tg-${++groupSeq}`;
  row.setAttribute("aria-owns", ul.id);
  return ul;
}

/** The open workspace's files: the sidebar's tree. */
function renderWorkspaceTree(repo: Repo): HTMLElement {
  const tree = trees.get(repo.id);
  const loaded = tree && !("error" in tree) ? tree : null;
  const note = (text: string, error = false) => h("p", { class: `tree-note${error ? " error" : ""}` }, text);
  if (repo.status === "importing" && !loaded?.files.length) return note("Importing…");
  if (repo.status === "error") return note(repo.error ?? "The import failed.", true);
  if (!tree) return h("div", { class: "tree-note", "aria-busy": "true" });
  if (!loaded) return note((tree as { error: string }).error, true);
  if (!loaded.files.length) return note("No notes yet.");
  const ul = renderFolder(repo, folderCache.get(repo.id) ?? buildFolders(loaded.files), 1);
  ul.setAttribute("role", "tree");
  ul.className = "tree";
  ul.setAttribute("aria-label", `Files in ${repo.title}`);
  return ul;
}

function renderFolder(repo: Repo, folder: Folder, level: number): HTMLElement {
  const ul = h("ul", { role: "group" });
  const folders = [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const f of folders) {
    const key = dirKey(repo.id, f.path);
    const open = isOpen(key, repo.id);
    const setOpen = (next: boolean) => {
      setOpenState(key, repo.id, next);
      renderTree();
    };
    const row = h("div", {
      class: "folder-row", role: "treeitem", tabindex: "-1", "aria-level": String(level), "aria-expanded": String(open),
      "data-key": key, title: f.path, style: { "--depth": String(level) },
      onclick: (e: MouseEvent) => (focusRow(e.currentTarget as HTMLElement), setOpen(!open)),
    },
      chevron(),
      inlineRename?.key === key ? inlineRename.input : h("span", { class: "folder-name" }, f.name),
    );
    const writable = !repo.readOnly;
    const here = () => void newNote(repo.id, `${f.path}/`);
    const items = () => rowMenu(repo, `${f.path}/`, () => renameFolderInline(repo, f.path), () => void deleteRowByKey(key));
    bindRow(row, { activate: () => setOpen(!open), setOpen, menu: items, remove: repo.readOnly ? undefined : () => deleteFolder(repo, f.path) });
    const add = writable
      ? h("button", { type: "button", class: "icon-btn row-add folder-add", tabindex: "-1", title: `New note in ${f.name}`, "aria-label": `New note in ${f.name}`, onclick: (e: MouseEvent) => (e.preventDefault(), e.stopPropagation(), here()) }, "+")
      : null;
    ul.appendChild(h("li", { role: "none", class: "folder-item" }, row, add, writable ? menuButton(key, `${f.name} actions`, items) : null, open ? group(row, renderFolder(repo, f, level + 1)) : null));
  }
  for (const path of folder.files) ul.appendChild(renderFile(repo, path, level));
  return ul;
}

function renderFile(repo: Repo, path: string, level: number) {
  const active = current?.repo === repo.id && current.path === path;
  const users = (presence.get(fkey(repo.id, path)) ?? []).filter((u) => u.id !== me.id);
  const items = () => [...rowMenu(repo, parentDir(path), () => renameNoteInline(repo, path), () => void deleteRowByKey(key)), { label: "Copy Link", run: () => void copyNoteLink(repo.id, path) }];
  const name = displayName(path);
  const key = `file:${fkey(repo.id, path)}`;
  const a = h("a", {
    class: `file-row${active ? " active" : ""}`, href: urlFor(repo.id, path), role: "treeitem", tabindex: "-1", "aria-level": String(level),
    "aria-current": active ? "page" : undefined,
    "data-key": key, style: { "--depth": String(level) }, title: path,
  },
    inlineRename?.key === key ? inlineRename.input : h("span", { class: "file-name" }, name),
    users.length
      ? h("span", { class: "presence-dots", role: "img", "aria-label": `${users.map((u) => u.name).join(", ")} here`, title: users.map((u) => u.name).join(", ") },
          users.slice(0, 4).map((u) => h("span", { class: `pdot${u.kind === "agent" ? " is-agent" : ""}${arrived(`${key}:${u.id}`) ? " arrived" : ""}`, style: { "--c": u.color } })),
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
  bindRow(a, { activate: () => navigate(repo.id, path), menu: items, remove: repo.readOnly ? undefined : () => deleteFile(repo, path) });
  // likely to be opened next: fetch its text now, so it shows at once (hover: after a moment, not while passing over)
  let hover = 0;
  a.addEventListener("pointerenter", () => (hover = window.setTimeout(() => prefetchNote(repo.id, path), 60)));
  a.addEventListener("pointerleave", () => clearTimeout(hover));
  a.addEventListener("pointerdown", () => prefetchNote(repo.id, path));
  // (v2: not on focus: arrow keys open the row they land on anyway, and each prefetch spends the socket's open rate)
  a.addEventListener("focus", () => !noteSocket && prefetchNote(repo.id, path));
  return h("li", { role: "none", class: `file-item${active ? " active" : ""}` }, a, menuButton(key, `${name} actions`, items));
}

/** The header's "⋯" menu for the open note. */
function noteMenu(): MenuItem[] {
  if (!current || !session) return [];
  const { repo: repoId, path } = current;
  const repo = repoById(repoId);
  const readOnly = !repo || repo.readOnly || session.readOnly;
  return [
    { label: history.open ? "Hide History" : "Show History", run: () => history.toggle() },
    { label: showAuthors() ? "Hide Authors" : "Show Authors", run: () => setShowAuthors(!showAuthors()) },
    "sep",
    { label: "Rename…", disabled: readOnly, run: () => repo && revealRow(repo, path) && renameNoteInline(repo, path) },
    { label: "Delete…", disabled: readOnly, danger: true, run: () => repo && revealRow(repo, path) && void deleteRowByKey(`file:${fkey(repo.id, path)}`) },
    "sep",
    { label: "Copy Link", run: () => void copyNoteLink(repoId, path) },
  ];
}

/** Note `path`'s tree row on screen (its folders open, the sidebar shown in a narrow window), for the header's Rename and Delete. */
function revealRow(repo: Repo, path: string) {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const key = dirKey(repo.id, parts.slice(0, i).join("/"));
    if (!isOpen(key, repo.id)) setOpenState(key, repo.id, true);
  }
  if (window.matchMedia("(max-width: 640px)").matches) setSidebarOpen(true);
  renderTree();
  flushTree();
  return true;
}

/** A note row's Copy Link: the note's web URL (what opens it here; the Mac app copies the same). */
async function copyNoteLink(repo: string, path: string) {
  if (await copyText(location.origin + urlFor(repo, path))) toast("Link copied");
  else toast("Couldn't copy the link", "error");
}

/** "dir/sub/" for "dir/sub/note.md" ("" at the top). */
function parentDir(path: string) {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

/** A tree row's menu (its "⋯" and right-click): new notes and folders go in `dir` (the folder, or the note's folder). */
function rowMenu(repo: Repo, dir: string, rename: () => void, remove: () => void): MenuItem[] {
  if (repo.readOnly) return [];
  return [
    { label: "New note", run: () => void newNote(repo.id, dir) },
    { label: "New folder", run: () => void newSubfolder(repo, dir) },
    { label: "Rename", run: rename },
    { label: "Delete", danger: true, run: remove },
  ];
}

// ---------- renaming in place ----------

/** The tree row being renamed in place: its key and the input that replaces its name (kept across re-renders). */
let inlineRename: { key: string; input: HTMLInputElement } | null = null;
/** True while the tree re-renders (moving the rename input blurs it; that isn't the user leaving it). */
let treeRendering = false;

/** Put row `key` into rename mode with `value`; `commit(name)` runs on Enter or blur with a changed, non-empty name. */
function startInlineRename(key: string, value: string, label: string, commit: (name: string) => Promise<void>) {
  finishInlineRename?.(false);
  const input = h("input", { class: "row-rename", type: "text", value, "aria-label": label, spellcheck: "false", autocomplete: "off" }) as HTMLInputElement;
  let done = false;
  const finish = (save: boolean, refocus = true) => {
    if (done) return;
    done = true;
    finishInlineRename = null;
    inlineRename = null;
    const name = input.value.trim();
    renderTree();
    flushTree();
    if (refocus) focusRow(treeEl.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) ?? undefined);
    if (save && name && name !== value) {
      if (/[/\\]/.test(name) || name === "." || name === "..") return toast("A name can't contain / or \\.", "error");
      void commit(name);
    }
  };
  finishInlineRename = (save) => finish(save, false);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => {
    if (!treeRendering) finish(true, false);
  });
  // Inside a note's link: clicks place the caret, they don't open the note or toggle the folder.
  input.addEventListener("click", (e) => (e.preventDefault(), e.stopPropagation()));
  inlineRename = { key, input };
  renderTree();
  flushTree();
  input.focus();
  input.select();
}
let finishInlineRename: ((save: boolean) => void) | null = null;

/** After a rename, the renamed row stays the tree's current row (and keeps focus if the tree has it). */
function followRenamedRow(from: string, to: string, wasFocused: boolean) {
  // (the tree may have re-rendered meanwhile, with focus falling to another row)
  const focused = wasFocused && treeHasFocus;
  if (treeFocusKey === from || treeFocusKey === null || focused) treeFocusKey = to;
  renderTree();
  flushTree();
  if (focused) focusRow(treeEl.querySelector<HTMLElement>(`[data-key="${CSS.escape(to)}"]`) ?? undefined);
}

function renameNoteInline(repo: Repo, path: string) {
  if (!signedInFor(repo, { kind: "rename", path })) return;
  const name = displayName(path);
  const ext = path.slice(path.length - (path.match(MD_EXT)?.[0].length ?? 0));
  startInlineRename(`file:${fkey(repo.id, path)}`, name, `Rename ${name}`, async (to) => {
    const dest = parentDir(path) + to + (ext || ".md");
    const wasFocused = treeHasFocus;
    try {
      if (current?.repo === repo.id && current.path === path) session?.expectRename(dest);
      await api.rename(repo.id, path, dest);
      await loadTree(repo.id, false);
      followRenamedRow(`file:${fkey(repo.id, path)}`, `file:${fkey(repo.id, dest)}`, wasFocused);
    } catch (err) {
      session?.expectRename(null);
      toast(err instanceof ApiError && err.status === 409 ? `“${to}” already exists.` : errorMessage(err), "error");
    }
  });
}

function renameFolderInline(repo: Repo, dir: string) {
  if (!signedInFor(repo, { kind: "renameFolder", path: dir })) return;
  const name = dir.slice(dir.lastIndexOf("/") + 1);
  startInlineRename(dirKey(repo.id, dir), name, `Rename folder ${name}`, async (to) => {
    const dest = dir.slice(0, dir.length - name.length) + to;
    const wasFocused = treeHasFocus;
    try {
      if (current?.repo === repo.id && current.path.startsWith(`${dir}/`)) session?.expectRename(dest + current.path.slice(dir.length));
      await api.renameFolder(repo.id, dir, dest);
      // the renamed folder (and its open subfolders) stay open
      for (const [k, v] of [...openState]) {
        const prefix = dirKey(repo.id, dir);
        if (k === prefix || k.startsWith(`${prefix}/`)) openState.set(dirKey(repo.id, dest) + k.slice(prefix.length), v);
      }
      if (!isOpen(dirKey(repo.id, dest), repo.id)) setOpenState(dirKey(repo.id, dest), repo.id, true);
      saveTreeState();
      await loadTree(repo.id, false);
      followRenamedRow(dirKey(repo.id, dir), dirKey(repo.id, dest), wasFocused);
    } catch (err) {
      session?.expectRename(null);
      toast(err instanceof ApiError && err.status === 409 ? `“${to}” already exists.` : errorMessage(err), "error");
    }
  });
}

// ---------- search files (Ctrl+P) ----------

/** The "Search files" dialog over the open folder's notes; the chosen note opens with the editor focused. */
async function searchFiles() {
  const ws = repoById(wsId);
  if (!ws) return;
  const files = () => {
    const t = trees.get(ws.id);
    return t && !("error" in t) ? t.files : null;
  };
  const choose = (path: string) => {
    if (session && session.repo === ws.id && session.path === path) return focusEditor();
    focusNextEditor = true;
    navigate(ws.id, path);
  };
  if (files()) return openFileSearch(files(), choose);
  if (ws.status === "ready") await loadTree(ws.id);
  openFileSearch(files() ?? [], choose);
}

// ---------- actions ----------

/** The workspace if I can write in it. */
function writableRepoFor(id: string | null | undefined): Repo | undefined {
  const r = repoById(id ?? null);
  return r && !r.readOnly ? r : undefined;
}

/** Make the next mounted editor take focus (a note just created from the sidebar). */
let focusNextEditor = false;
/** A "New note" is being created (one at a time: a double click or a held key makes one note). */
let creatingNote = false;
/**
 * Keys typed while a new note is being made (before its editor is there): text, "\n" for Enter, "\b" for Backspace.
 * Replayed into the note's editor when it takes focus, so "# Title" + Enter typed at once lands in the note.
 */
let typedAhead: { keys: string[]; path: string | null; until: number } | null = null;

/** Capture phase, document: hold keys typed for the note being made (they'd otherwise go to the page or sidebar). */
function bufferTypedAhead(e: KeyboardEvent) {
  if (!typedAhead) return;
  if (performance.now() > typedAhead.until) return void (typedAhead = null);
  const t = e.target as HTMLElement | null;
  if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey || docBody.contains(t) || t?.closest?.("dialog, input, textarea, [contenteditable=true]")) return;
  const k = e.key.length === 1 ? e.key : e.key === "Enter" ? "\n" : e.key === "Backspace" ? "\b" : null;
  if (!k) return;
  e.preventDefault();
  e.stopPropagation();
  typedAhead.keys.push(k);
}

/**
 * "New note": at once, the first free Untitled.md (Untitled 2.md, …) in `dir` (default: the open note's folder),
 * opened with the caret at the start. Its first-line H1 names it later (Session.autoName).
 */
async function newNote(repoId?: string, dir?: string) {
  if (creatingNote) return;
  const repo = writableRepoFor(repoId ?? wsId);
  if (!repo) return toast("You can't add notes to this workspace.", "error");
  if (!signedInFor(repo, { kind: "newNote", dir })) return;
  // Until the new note's editor takes focus, keys typed for it mustn't go to the sidebar control that started it
  // (Space/Enter would make another note) or to the tree (its type-ahead, Enter on the open row).
  if (document.activeElement instanceof HTMLElement && document.activeElement.closest("#sidebar")) document.activeElement.blur();
  treeHasFocus = false;
  creatingNote = true;
  typedAhead = { keys: [], path: null, until: performance.now() + 10_000 };
  try {
    if (!(await createUntitled(repo, dir))) typedAhead = null;
  } finally {
    creatingNote = false;
  }
}

/** Create and open the note; true if it was. */
async function createUntitled(repo: Repo, dir: string | undefined): Promise<boolean> {
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
      if (typedAhead) typedAhead.path = res.path;
      navigate(repo.id, res.path);
      return true;
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409)) {
        toast(errorMessage(err), "error");
        return false;
      }
      tried.push(path);
    }
  }
  toast("Couldn't find a free name for the new note.", "error");
  return false;
}

/**
 * "New folder" in `dir`: folders only exist through their files (Git has no empty directories), so this makes
 * "New folder/Untitled.md" ("New folder 2", …), opens that note and puts the folder's name into rename mode.
 */
async function newSubfolder(repo: Repo, dir: string) {
  if (repo.readOnly) return toast("You can't add notes to this workspace.", "error");
  if (!signedInFor(repo, { kind: "newFolder", dir })) return;
  if (!trees.has(repo.id) || "error" in trees.get(repo.id)!) await loadTree(repo.id, false);
  const tree = trees.get(repo.id);
  const files = tree && !("error" in tree) ? tree.files : [];
  const taken = new Set(files.filter((f) => f.startsWith(dir)).map((f) => f.slice(dir.length).split("/")[0]!.toLowerCase()));
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? "New folder" : `New folder ${n}`;
    if (taken.has(name.toLowerCase())) continue;
    const folder = dir + name;
    try {
      const res = await api.createFile(repo.id, `${folder}/Untitled.md`, "");
      setOpenState(dirKey(repo.id, folder), repo.id, true);
      await loadTree(repo.id, false);
      navigate(repo.id, res.path);
      renameFolderInline(repo, folder);
      return;
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409)) return toast(errorMessage(err), "error");
      taken.add(name.toLowerCase());
    }
  }
  toast("Couldn't find a free name for the new folder.", "error");
}

async function deleteFolder(repo: Repo, dir: string): Promise<boolean> {
  if (!signedInFor(repo, { kind: "deleteFolder", path: dir })) return false;
  const tree = trees.get(repo.id);
  const n = tree && !("error" in tree) ? tree.files.filter((f) => f.startsWith(`${dir}/`)).length : 0;
  const ok = await confirmDialog({ title: "Delete folder", message: `Delete “${dir}” and the ${n === 1 ? "note" : `${n} notes`} in it? They stay in the Git history.`, confirm: "Delete", danger: true });
  if (!ok) return false;
  try {
    await api.deleteFolder(repo.id, dir);
    await loadTree(repo.id);
    return true;
  } catch (err) {
    toast(errorMessage(err), "error");
    return false;
  }
}

async function createWorkspace(title: string) {
  const ws = await api.createWorkspace(title);
  await loadRepos();
  switchWorkspace(ws.id);
  toast(`Created “${ws.title}”`);
}

// For the open file, the server closes its room ("removed" / "renamed" / "deleted") and Session.onClosed navigates.

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

async function deleteFile(repo: Repo, path: string): Promise<boolean> {
  if (!signedInFor(repo, { kind: "delete", path })) return false;
  const ok = await confirmDialog({ title: "Delete note", message: `Delete “${path}”? It stays in the Git history.`, confirm: "Delete", danger: true });
  if (!ok) return false;
  try {
    await api.deleteFile(repo.id, path);
    await loadTree(repo.id);
    return true;
  } catch (err) {
    toast(errorMessage(err), "error");
    return false;
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

/** A demo room's workspace id ("demo.<room>"): its links are /app/demo/… (whoever opens one gets a room of their own). */
function isDemoRoom(id: string | null | undefined): id is string {
  return !!id && /^demo\.[a-z0-9]{10}$/.test(id);
}

/** The id links and saved state use: "demo" for my demo room. */
function canonId(id: string): string {
  return isDemoRoom(id) ? DEMO_ID : id;
}

/** My demo room, once the server said (POST /api/demo/room); null to ask again. */
let demoRoom: string | null = null;

/** /app/demo opens my demo room: the same one again while it's there (the server knows this browser by its guest id). */
async function resolveDemoRoom(): Promise<string | null> {
  if (demoRoom) return demoRoom;
  try {
    demoRoom = (await api.demoRoom()).workspace;
  } catch (err) {
    showDemoBusy(err);
    return null;
  }
  return demoRoom;
}

function showDemoBusy(err: unknown) {
  closeSession();
  current = null;
  renderHeader();
  clear(docBody, h("div", { class: "empty-state no-folder" },
    h("h2", null, "The demo is busy"),
    h("p", { class: "muted" }, err instanceof ApiError && err.status === 503 ? "Every demo room is taken right now. Try again in a minute." : errorMessage(err)),
    h("div", { class: "row" }, h("button", { type: "button", class: "btn", onclick: () => void route() }, "Try Again")),
  ));
}

function urlFor(repo: string, path?: string) {
  repo = canonId(repo);
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

function readLastNote(): { repo: string; path: string } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_NOTE_KEY) ?? "null") as { user?: string; repo?: unknown; path?: unknown } | null;
    if (raw?.user === me.id && typeof raw.repo === "string" && typeof raw.path === "string") return { repo: raw.repo, path: raw.path };
  } catch {}
  return null;
}

function saveLastNote(repo: string, path: string) {
  repo = canonId(repo);
  try {
    localStorage.setItem(LAST_NOTE_KEY, JSON.stringify({ user: me.id, repo, path }));
    const all = lastNotes();
    delete all[repo];
    // newest last; keep the newest 100 workspaces
    localStorage.setItem(LAST_BY_WS_KEY, JSON.stringify({ user: me.id, notes: Object.fromEntries([...Object.entries(all), [repo, path]].slice(-100)) }));
  } catch {}
}

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
  repo = canonId(repo);
  try {
    const all = lastNotes();
    delete all[repo];
    localStorage.setItem(LAST_BY_WS_KEY, JSON.stringify({ user: me.id, notes: all }));
    if (readLastNote()?.repo === repo) localStorage.removeItem(LAST_NOTE_KEY);
  } catch {}
}

/** The workspace /app opens when nothing else says which: the first joined one, else the first I can open. */
/** Signed in with an account (not a visitor of a server without sign-in): the demo isn't for us. */
function hasAccount() {
  return signedIn && !noSignIn;
}

function firstWorkspace(): string | null {
  const joined = workspaces.filter((w) => repoById(w.id));
  // an account lands in its own workspaces only (not a shared one it never opened; never the demo)
  if (hasAccount()) return joined.find((w) => w.kind === "notes")?.id ?? joined[0]?.id ?? null;
  return joined.find((w) => w.kind === "notes")?.id ?? joined[0]?.id ?? repos.find((x) => x.kind === "notes")?.id ?? repos[0]?.id ?? null;
}

async function route() {
  const seq = ++routeSeq;
  // Outside /app (e.g. back to the home page): that's a different page.
  if (!isAppPath(location.pathname)) return location.reload();
  const skipLast = skipLastNote;
  skipLastNote = false;
  setSidebarOpen(false);
  let r = parseRoute();
  // the demo is for people who aren't signed in: an account goes to its own workspace instead
  if ((r?.repo === DEMO_ID || isDemoRoom(r?.repo)) && hasAccount()) {
    window.history.replaceState(null, "", "/app");
    r = null;
  }
  const last = !r && !skipLast ? readLastNote() : null;
  let id = r?.repo ?? (last && (repoById(last.repo) || (last.repo === DEMO_ID && !hasAccount())) ? last.repo : null) ?? (skipLast && repoById(wsId) ? wsId : null) ?? firstWorkspace();
  // /app/demo: my demo room (asked for once; again if it went or filled up)
  if (id === DEMO_ID || isDemoRoom(id)) {
    const room = await resolveDemoRoom();
    if (seq !== routeSeq || !room) return;
    id = room;
  }
  if (!id && (!signedIn || noSignIn)) {
    // nothing to open for a guest or a visitor (a hosted server has no shared workspace): the public demo
    window.history.replaceState(null, "", urlFor(DEMO_ID) + location.search + location.hash);
    return route();
  }
  if (!id && hasAccount()) {
    // an account with no workspace yet (its first sign-in, or it only ever had the demo): its own, made now
    const own = await api.personalWorkspace().catch((err: unknown) => (console.warn("personal workspace:", err), null));
    if (seq !== routeSeq) return;
    if (own) {
      await loadRepos();
      if (seq !== routeSeq) return;
      window.history.replaceState(null, "", urlFor(own.id) + location.search + location.hash);
      return route();
    }
  }
  if (!id) {
    setWorkspace(null);
    return showEmpty();
  }
  // another workspace: the one open stays on screen until the new one's tree and note are here
  if (revealed && id !== wsId) {
    await prepareWorkspace(id, r?.path ?? (skipLast ? undefined : lastNotes()[canonId(id)]));
    if (seq !== routeSeq) return;
  }
  if (!(await openWorkspace(id))) return;
  if (seq !== routeSeq) return;
  if (r?.path) {
    const canonical = urlFor(id, r.path);
    if (location.pathname !== canonical) window.history.replaceState(null, "", canonical + location.search + location.hash);
    return openFile(id, r.path);
  }
  const remembered = skipLast ? undefined : lastNotes()[canonId(id)];
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

/** Load what switching to workspace `id` shows first (its details, tree, and the note it opens), capped. */
async function prepareWorkspace(id: string, path: string | undefined) {
  const load = async () => {
    if (!repoById(id)) {
      if (!trees.has(id)) prefetchEarly(`tree:${id}`, () => api.tree(id));
      try {
        const repo = await take(`repo:${id}`, () => api.repo(id));
        repos = [...repos.filter((x) => x.id !== id), repo];
      } catch {
        // (opening it says why)
        return;
      }
    }
    if (repoById(id)?.status !== "ready") return;
    const target = path ?? (await defaultFile(id));
    if (target) await noteCache.prefetch(id, target, FRESH_MS);
  };
  await Promise.race([load(), new Promise((done) => setTimeout(done, BOOT_CAP_MS))]);
}

function setWorkspace(id: string | null) {
  // only the selected workspace keeps a socket
  if (noteSocket && noteSocket.workspace !== id) id ? noteSocket.socket(id) : noteSocket.close();
  if (id === wsId) return;
  wsId = id;
  treeFocusKey = null;
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
      // (its tree loads meanwhile)
      if (!trees.has(id)) prefetchEarly(`tree:${id}`, () => api.tree(id));
      const repo = await take(`repo:${id}`, () => api.repo(id));
      repos = [...repos.filter((x) => x.id !== id), repo];
    } catch (err) {
      // my demo room went, or is full for me now: ask for one again (once)
      if (isDemoRoom(id) && err instanceof ApiError && (err.status === 404 || err.status === 409) && demoRoom === id) {
        demoRoom = null;
        void route();
        return false;
      }
      setWorkspace(id);
      showMissing(id, err);
      return false;
    }
  }
  setWorkspace(id);
  if (!signedIn && !isDemoRoom(id)) {
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
  document.title = "Grim";
  history.setTarget(null);
  renderHeader();
  const missing = err instanceof ApiError && err.status === 404;
  clear(docBody, h("div", { class: "empty-state no-folder" },
    h("h2", null, missing ? "No such workspace" : "Couldn't open this workspace"),
    h("p", { class: "muted" }, missing ? `“${id}” doesn't exist on ${location.host}.` : errorMessage(err)),
    h("div", { class: "row" }, h("button", { type: "button", class: "btn", onclick: () => goHome() }, "Go to my workspaces")),
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
  /** The editor had focus (not, e.g., a folder rename typed in the tree). */
  focused: boolean;
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
  document.title = `${displayName(path)} · Grim`;
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
  document.title = "Grim";
  history.setTarget(null);
  renderHeader();
  renderTree();
  const repo = writableRepoFor(wsId);
  const ws = repoById(wsId);
  clear(docBody, h("div", { class: "empty-state" },
    h("span", { class: "label" }, ws ? "Nothing open" : "Welcome"),
    h("h2", null, ws ? (ws.status === "importing" ? "Importing…" : "No note open.") : "Start a workspace."),
    h("p", { class: "muted" }, ws ? "Pick a note from the sidebar, or start a new one." : "A workspace holds Markdown notes you can share."),
    ws
      ? repo ? h("button", { type: "button", class: "btn btn-primary", onclick: () => void newNote(repo.id) }, "New note") : null
      : h("button", { type: "button", class: "btn btn-primary", onclick: () => newFolder() }, "New workspace"),
  ));
}

function renderHeader() {
  moreBtn.hidden = !session;
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

/** Presence shown so far (people per note row, and in the header). */
const seenPresence = new Set<string>();

/** Whether `key` (a person somewhere) shows for the first time after the first view: it fades in. */
function arrived(key: string) {
  if (seenPresence.has(key)) return false;
  seenPresence.add(key);
  return revealed;
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
  // alone in the note: no avatars (just us isn't news)
  if (users.length < 2) return clear(participantsEl);
  clear(participantsEl, users.slice(0, 6).map((u) => {
    const el = avatar(u);
    if (arrived(`avatar:${u.id}`)) el.classList.add("arrived");
    if (u.self) {
      // no ring for us, even as a guest
      el.classList.remove("is-guest");
      el.title = signedIn ? `${u.name} (you)` : `${u.name} (you, not signed in)`;
    }
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
    } else text = session.slow ? "Connecting…" : "";
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

/** Recently seen note text (shown the moment a note opens) and its prefetches. */
const noteCache = new NoteCache({ fetch: async (repo, path) => (await take(`file:${fkey(repo, path)}`, () => api.file(repo, path))).content });
/** A cached copy younger than this isn't fetched again when its note opens or its row is hovered. */
const FRESH_MS = 5_000;

/** Prefetch a note the user is likely to open next (its row hovered or focused, or next to the open note). */
function prefetchNote(repo: string, path: string, intent = true) {
  if (session?.repo === repo && session.path === path) return;
  // v2: open it as a hidden channel (its engine synced, kept live); v1: its text over HTTP
  if (noteSocket) noteSocket.prefetch(repo, path, intent);
  else void noteCache.prefetch(repo, path, FRESH_MS);
}

/** The notes above and below the open one in the tree: arrow keys open them at once. */
function prefetchNeighbours(repo: string, path: string) {
  const rows = visibleRows();
  // (by its key: the tree may not have re-rendered the current row yet)
  const key = `file:${fkey(repo, path)}`;
  const i = rows.findIndex((r) => r.dataset.key === key);
  if (i < 0) return;
  const targets = [rows[i + 1], rows[i - 1]].flatMap((row) => {
    const target = row?.classList.contains("file-row") ? row.dataset.key?.slice("file:".length).split("\u0000") : null;
    return target?.length === 2 && target[1] !== path ? [[target[0]!, target[1]!] as const] : [];
  });
  // v2: one hidden channel at a time (the open rate is limited): the neighbour that isn't warm yet, below first
  // (walking down, the one above is the previous note)
  const ns = noteSocket;
  for (const [r, p] of ns ? targets.filter(([, p]) => !ns.isWarm(p)).slice(0, 1) : targets) prefetchNote(r, p, false);
}

function demoBanner(repo: string) {
  return isDemoRoom(repo) ? h("div", { class: "demo-banner", role: "note" }, `Demo workspace — anyone can edit; your copy resets ${demoResetPhrase(config?.demoResetMinutes)}.`) : null;
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
  private readonly opened = performance.now();
  /** The editor couldn't start or crashed: the note is shown read-only. */
  failed = false;
  /**
   * "Connecting…" may show: opening has taken 300 ms with nothing on screen, or 3 s while the note's last known
   * text shows (that's a note on screen, not a wait: the first load and instant opens say nothing until then).
   */
  slow = false;
  /** The note's last known text, shown read-only until the live document has synced (mount() replaces it). */
  private previewEditor: EditorHandle | null = null;
  private previewText: string | null = null;
  private neighboursFetched = false;
  /** Keys typed into the preview, for the live editor. */
  private previewKeys: string[] = [];
  private markShown = () => {};
  /** Resolves once the note shows (its text, read-only or live) or says why it can't (the first load waits for it). */
  readonly shown = new Promise<void>((done) => (this.markShown = done));

  constructor(
    readonly repo: string,
    readonly path: string,
    private carry: Carry | null = null,
  ) {
    this.localUser = localUser();
    // v2: a prefetched note (a hidden channel) has its engine syncing or synced already
    const warm = noteSocket && !carry && !keptUnsent(me.id, repo, path) ? noteSocket.take(repo, path) : null;
    // (after openFile has made this the session)
    const remember = () => queueMicrotask(() => session === this && !this.ended && saveLastNote(repo, path));
    if (warm?.synced) {
      // its "synced" came before connect() listened
      remember();
      this.connect(warm);
      this.everConnected = warm.status === "connected";
      this.mount();
      return;
    }
    // At once: the note's last known text (read-only until the live document syncs), else a quiet bar after 300 ms.
    const known = carry ? null : noteCache.get(repo, path);
    // a copy the server gave moments ago (switching workspaces reads the note first) is the last note at once, as the
    // HTTP read below makes it (v2 after the first load skips that read and would wait for the channel to sync)
    if (known && performance.now() - known.at < FRESH_MS) remember();
    if (carry) {
      clear(docBody, carry.placeholder);
      this.markShown();
    } else if (known) this.preview(known.text);
    else clear(docBody, h("div", { class: "note-pending", role: "status", "aria-label": "Loading note" }));
    // and over HTTP alongside the socket, unless the copy is from moments ago (v2: the channel brings it as fast,
    // except on the first load, whose read started before the socket)
    if (!carry && (!noteSocket || !revealed)) {
      void noteCache.prefetch(repo, path, FRESH_MS).then((text) => {
        if (text === null || this.ended) return;
        // the server just had this note (a missing one gets null): it's the last note from now on, as when synced,
        // since its text may already be what's on screen
        if (session === this) saveLastNote(repo, path);
        if (!this.editor && !this.failed && text !== this.previewText) this.preview(text);
      });
    }
    const slow = (ms: number, unless: () => boolean) =>
      window.setTimeout(() => {
        if (this.ended || unless()) return;
        this.slow = true;
        if (session === this) renderSaveStatus();
      }, ms);
    slow(300, () => !!this.previewEditor || !!this.carry);
    slow(3000, () => false);
    if (warm) {
      this.connect(warm);
      this.everConnected = warm.status === "connected";
      return;
    }
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
        if (noteSocket) {
          noteSocket.setFactory(factory);
          return this.connect(noteSocket.open(repo, path, (workspace) => new RustCollab(factory, repo, path, this.localUser, { recover, workspace })));
        }
        const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws?${new URLSearchParams({ repo, path, ...guestQuery() })}`;
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

  /** Show `text` read-only in the editor's own rendering (no connection) until the live document has synced. */
  private preview(text: string) {
    this.previewText = text;
    // the note shows: no "Connecting…" for another while (see slow)
    if (this.slow && !this.everConnected && performance.now() - this.opened < 3000) {
      this.slow = false;
      if (session === this) renderSaveStatus();
    }
    const scroll = this.previewEditor ? docBody.scrollTop : 0;
    this.previewEditor?.destroy();
    const host = h("div", { class: "editor-host preview" });
    // keys typed into the preview are held and typed into the live editor when it takes over (at the same caret)
    host.addEventListener("keydown", (e) => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.length === 1 ? e.key : e.key === "Enter" ? "\n" : e.key === "Backspace" ? "\b" : null;
      if (!k) return;
      e.preventDefault();
      this.previewKeys.push(k);
    });
    clear(docBody, demoBanner(this.repo), host);
    this.previewEditor = mountEditor(host, { text, readOnly: true, images: repoImages(this.path, (p) => rawUrl(this.repo, p)), onLink: (t) => openLink(this, t) });
    docBody.scrollTop = scroll;
    void this.previewEditor.ready.then(() => this.markShown());
  }

  /** The editor can't run: the note's Markdown read-only (`text`, or the server's copy) under a notice. */
  private showReadOnly(text: string | null, message: string, actions: { label: string; run: () => void }[] = []) {
    this.failed = true;
    this.previewEditor?.destroy();
    this.previewEditor = null;
    renderSaveStatus();
    this.banner = null;
    this.host.replaceChildren();
    clear(docBody, this.host);
    const { repo, path } = this;
    this.fallback = showFallback(this.host, text ?? api.file(repo, path).then((r) => r.content, () => null), message, actions);
    this.markShown();
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

  /** The note's text on screen, live or the read-only preview. */
  shownText(): string | null {
    return this.editor?.text() ?? this.previewText;
  }

  /** The note's text as shown, or null before the editor is up. */
  text(): string | null {
    return this.editor?.text() ?? null;
  }

  /** Other participants' presence states. */
  peerStates(): [number, unknown][] {
    return this.provider?.peerStates() ?? [];
  }

  /** This session is about to rename its note to `to` (null: it didn't): carry on there without a flash. */
  expectRename(to: string | null) {
    this.renamingTo = to;
  }

  /** Type the keys held while this new note was being made into its editor (through its own input handling). */
  private async replayTypedAhead(editor: EditorHandle) {
    const held = typedAhead;
    typedAhead = null;
    if (held?.keys.length) await this.typeInto(editor, held.keys);
  }

  /** Type `keys` (text, "\n" for Enter, "\b" for Backspace) into the editor through its own input handling. */
  private async typeInto(editor: EditorHandle, keys: string[]) {
    const view = await editor.ready;
    if (!keys.length || !view || this.editor !== editor || this.readOnly) return;
    const text = keys.join("");
    for (const m of text.matchAll(/\n|\x08|[^\n\x08]+/g)) {
      const k = m[0];
      const inputType = k === "\n" ? "insertParagraph" : k === "\b" ? "deleteContentBackward" : "insertText";
      view.root.dispatchEvent(new InputEvent("beforeinput", { inputType, data: inputType === "insertText" ? k : null, bubbles: true, cancelable: true }));
    }
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
    const focus = !this.editor && (mayFocusEditor() || focusNextEditor || !!this.carry?.focused);
    focusNextEditor = false;
    this.editor?.destroy();
    this.editor = null;
    this.host.replaceChildren();
    // the preview's scroll position and selection carry over (the live text is usually the same)
    const preview = this.previewEditor;
    const previewSel = preview?.selection() ?? null;
    const previewScroll = docBody.scrollTop;
    clear(docBody, demoBanner(this.repo), this.banner, this.host);
    preview?.destroy();
    this.previewEditor = null;
    // relative image paths load from the notebook (the raw endpoint), resolved against the note's folder
    const images = repoImages(this.path, (p) => rawUrl(this.repo, p));
    // images dropped or pasted in go into the notebook next to the note
    const upload = {
      // a guest outside the demo: the sign-in prompt instead
      allowed: () => signedInFor(repoById(this.repo), null, "upload"),
      upload: async (file: File) => (await api.uploadImage(this.repo, this.path, file)).markdown,
      notice: (m: string, kind?: "info" | "error") => toast(m, kind),
    };
    this.editor = mountEditor(this.host, { collab: this.provider!, readOnly: this.readOnly, images, onLink: (t) => openLink(this, t), upload, onEnter: () => this.autoName() });
    if (focus) this.editor.focus();
    if (focus && typedAhead?.path === this.path && performance.now() <= typedAhead.until) void this.replayTypedAhead(this.editor);
    const carry = this.carry;
    this.carry = null;
    if (carry?.sel) this.editor.select(carry.sel.anchor, carry.sel.head);
    if (carry) docBody.scrollTop = carry.scroll;
    if (preview) {
      const same = this.editor.text() === this.previewText;
      if (previewSel && same) this.editor.select(previewSel.anchor, previewSel.head);
      docBody.scrollTop = previewScroll;
      this.previewText = null;
      const keys = this.previewKeys.splice(0);
      if (keys.length && same && !this.readOnly) {
        this.editor.focus();
        void this.typeInto(this.editor, keys);
      }
    }
    const text = this.editor.text();
    if (text !== null) noteCache.put(this.repo, this.path, text);
    if (!this.neighboursFetched) {
      this.neighboursFetched = true;
      prefetchNeighbours(this.repo, this.path);
    }
    renderSaveStatus();
    // a link to a heading in this note (#fragment): once, when the note first shows
    if (!this.hashDone && location.hash.length > 1) this.scrollToHeading(decodeHash(location.hash));
    this.hashDone = true;
    this.markShown();
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
    // renaming needs an account (outside the demo): a guest's heading doesn't rename the note
    if (!canCreateIn(repoById(this.repo))) return;
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
          pendingCarry = { repo: this.repo, path: to, sel: this.editor?.selection() ?? null, scroll: docBody.scrollTop, placeholder, focused: this.host.contains(document.activeElement) };
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
        // deleted from the tree here: deleteRow opens the next note
        if (deletingOpen && deletingOpen.repo === this.repo && deletingOpen.path === this.path && performance.now() < deletingOpen.until) return;
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
    this.markShown();
    const text = this.editor?.text();
    if (text != null && !this.failed) noteCache.put(this.repo, this.path, text);
    this.previewEditor?.destroy();
    this.previewEditor = null;
    this.editor?.destroy();
    this.editor = null;
    this.fallback?.();
    const p = this.provider;
    this.provider = null;
    // v2: kept warm (hidden) as the previous note
    if (p && noteSocket && !this.failed) noteSocket.release(this.repo, this.path, p);
    else p?.destroy();
  }
}

function showAuthors(): boolean {
  try {
    return localStorage.getItem(SHOW_AUTHORS_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Line authors on or off (remembered in this browser): the editor's margin layer is hidden by a class on <html>. */
function setShowAuthors(on: boolean) {
  try {
    if (on) localStorage.removeItem(SHOW_AUTHORS_KEY);
    else localStorage.setItem(SHOW_AUTHORS_KEY, "0");
  } catch {}
  document.documentElement.classList.toggle("no-authors", !on);
}
