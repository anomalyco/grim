// Inline widgets (shared/widgets.ts) in the editor: which of a line's tags are drawn as widgets, the registry of
// renderers (name → chip), and the live data they show.
//
// A widget is an atomic chip (contenteditable=false, data-f/data-t: the tag's line-relative range) drawn in place of
// its source, which stays in the DOM collapsed (.wsrc) so the offset mapping holds. The caret never stops inside a
// tag (view.ts snaps it to an edge), Backspace after one / Delete before one removes the whole tag, and copying
// copies its source. A chip's text is in data-v attributes drawn by CSS (::before), so live updates change
// attributes only: the editor's MutationObserver (children and text) never sees them.

import { findWidgets, type WidgetMatch } from "../../shared/widgets.ts";
import type { RLine } from "./lineview.ts";

export type { WidgetMatch };

/** The widgets of a line drawn as chips: tags whose whole source is plain visible text (not inline code, a URL, …). */
export function lineWidgets(line: RLine, text: string): WidgetMatch[] {
  if (line.code || line.type === "fence" || line.type === "code") return [];
  const found = findWidgets(text);
  if (!found.length) return found;
  return found.filter((w) => line.segs.every((s) => s.to <= w.from || s.from >= w.to || (s.kind === "text" && !s.hidden && !s.cls.includes("code"))));
}

/** Of `widgets`, the one with `pos` strictly inside (line-relative). */
export function widgetAround(widgets: WidgetMatch[], pos: number): WidgetMatch | undefined {
  return widgets.find((w) => w.from < pos && pos < w.to);
}

// ---------------------------------------------------------------------------------------------
// Registry

export interface WidgetRenderer {
  /** Fill a new chip (its classes, data-f/data-t and data-w are set) from the tag's attributes. */
  render(chip: HTMLElement, attrs: Record<string, string>): void;
  /** Bring a chip drawn earlier up to date (attributes and classes only: see the top of this file). */
  update(chip: HTMLElement): void;
}

const renderers = new Map<string, WidgetRenderer>();

export function registerWidget(name: string, r: WidgetRenderer): void {
  renderers.set(name, r);
}

/** The chip for widget `w` (line-relative range). */
export function renderWidget(w: WidgetMatch): HTMLElement {
  const chip = document.createElement("span");
  chip.className = `wchip w-${w.name}`;
  chip.contentEditable = "false";
  chip.dataset.w = w.name;
  chip.dataset.f = String(w.from);
  chip.dataset.t = String(w.to);
  renderers.get(w.name)?.render(chip, w.attrs);
  return chip;
}

/** Refresh every chip of widget `name` on the page (`match`: only those it accepts). */
export function updateWidgets(name: string, match?: (chip: HTMLElement) => boolean): void {
  const r = renderers.get(name);
  if (!r || typeof document === "undefined") return;
  for (const chip of document.querySelectorAll<HTMLElement>(`.wchip[data-w="${name}"]`)) if (!match || match(chip)) r.update(chip);
}

// ---------------------------------------------------------------------------------------------
// Session data

/** What a session chip shows. Fields a source doesn't know are left out (and not drawn). */
export interface SessionInfo {
  id: string;
  title?: string;
  /** The session itself is running: its title shimmers. */
  busy?: boolean;
  /** How many subagents (child sessions) it has, and whether any of them is running (the count shimmers). */
  subagents?: number;
  subagentsBusy?: boolean;
}

/**
 * Where session chips get their data. The web's default is what Grim itself knows (KnownSessions); a live source
 * (an OpenCode server's events, as Grim for Mac has) can replace it with setSessionSource.
 */
export interface SessionInfoSource {
  get(id: string): SessionInfo | undefined;
  /** `listener(id)` after session `id` changed (null: anything may have); returns the unsubscribe. */
  subscribe(listener: (id: string | null) => void): () => void;
}

/**
 * Sessions Grim has seen: agents' Agent-Session-Id / Agent-Session-Name (line authors of the notes opened here,
 * agents' presence in this workspace and in the open note). Titles only: Grim doesn't know whether a session is
 * running or what subagents it has.
 */
export class KnownSessions implements SessionInfoSource {
  private titles = new Map<string, string>();
  private listeners = new Set<(id: string | null) => void>();

  get(id: string): SessionInfo | undefined {
    const title = this.titles.get(id);
    return title ? { id, title } : undefined;
  }

  subscribe(listener: (id: string | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Session `id` is called `title` (newest wins). */
  learn(id: unknown, title: unknown): void {
    if (typeof id !== "string" || !id || typeof title !== "string") return;
    const t = title.replace(/[\p{Cc}]+/gu, " ").trim().slice(0, 200);
    if (!t || this.titles.get(id) === t) return;
    this.titles.set(id, t);
    for (const l of this.listeners) l(id);
  }

  /** Learn from presence users / line authors (`{kind, session, sessionName}`; others are ignored). */
  learnUsers(users: unknown): void {
    if (!Array.isArray(users)) return;
    for (const u of users) {
      if (!u || typeof u !== "object") continue;
      const o = u as { session?: unknown; sessionName?: unknown };
      this.learn(o.session, o.sessionName);
    }
  }
}

export const knownSessions = new KnownSessions();
let source: SessionInfoSource = knownSessions;
let unsubscribe = source.subscribe(sessionChanged);

/** Use `s` for session chips (and redraw them); null: back to what Grim knows. */
export function setSessionSource(s: SessionInfoSource | null): void {
  unsubscribe();
  source = s ?? knownSessions;
  unsubscribe = source.subscribe(sessionChanged);
  updateWidgets("session");
}

export function sessionSource(): SessionInfoSource {
  return source;
}

function sessionChanged(id: string | null): void {
  updateWidgets("session", id === null ? undefined : (chip) => chip.dataset.id === id);
}

/** Longest title shown (then "…"); the full one is in the tooltip. */
const MAX_TITLE = 48;

export function truncate(s: string, max = MAX_TITLE): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max - 1).join("").trimEnd() + "…" : s;
}

/** "1 subagent", "3 subagents"; "" for none. */
export function subagentLabel(n: number | undefined): string {
  return n && n > 0 ? `${n} subagent${n === 1 ? "" : "s"}` : "";
}

/** `<session id="…" />`: ◆ title (or the id) · N subagents; the title shimmers while the session runs, the count while a subagent does. */
registerWidget("session", {
  render(chip, attrs) {
    chip.dataset.id = attrs.id!.trim();
    const title = document.createElement("span");
    title.className = "wt";
    const count = document.createElement("span");
    count.className = "wc";
    chip.append(title, count);
    this.update(chip);
  },
  update(chip) {
    const id = chip.dataset.id ?? "";
    const info = source.get(id);
    const [title, count] = [chip.querySelector<HTMLElement>(".wt"), chip.querySelector<HTMLElement>(".wc")];
    if (!title || !count) return;
    const name = info?.title?.trim() || id;
    title.dataset.v = truncate(name);
    title.classList.toggle("busy", !!info?.busy);
    chip.classList.toggle("known", !!info?.title);
    const n = subagentLabel(info?.subagents);
    count.dataset.v = n ? ` · ${n}` : "";
    count.classList.toggle("busy", !!n && !!info?.subagentsBusy);
    chip.title = info?.title ? `${info.title}\nSession ${id}` : `Session ${id}`;
    chip.setAttribute("aria-label", `Session ${name}${n ? `, ${n}` : ""}${info?.busy ? ", running" : ""}`);
    chip.setAttribute("role", "img");
  },
});

// for tests and debugging: plug a source in from the page (`grimWidgets.setSessionSource({get, subscribe})`)
if (typeof window !== "undefined") (window as unknown as { grimWidgets?: unknown }).grimWidgets = { setSessionSource, knownSessions, updateWidgets };
