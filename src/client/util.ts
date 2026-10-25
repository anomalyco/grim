// DOM and formatting helpers.

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === "class") {
        el.className = String(v);
      } else if (k === "style" && typeof v === "object") {
        for (const [prop, val] of Object.entries(v as Record<string, string>)) el.style.setProperty(prop, val);
      } else if (k === "value" || k === "checked" || k === "disabled" || k === "hidden") {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else {
        el.setAttribute(k, v === true ? "" : String(v));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: (Child | Child[])[]) {
  for (const c of children) {
    if (Array.isArray(c)) append(el, c);
    else if (c === null || c === undefined || c === false) continue;
    else el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element, ...children: (Child | Child[])[]) {
  el.replaceChildren();
  append(el, children);
}

// Same idea as the server: a stable color from a fixed palette, picked by hashing the id.
const PALETTE = ["#296d9a", "#1a4d65", "#2b6a54", "#826465", "#5c6b57", "#7c4d3a", "#4a5568", "#3d5a80", "#6a5a8c", "#8a5a2b", "#2f6f6f", "#5b5b5b"];

export function colorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export interface AvatarUser {
  id: string;
  name: string;
  color?: string | null;
  kind?: string;
  avatar?: string | null;
}

export function avatar(u: AvatarUser): HTMLElement {
  const color = u.color && COLOR_RE.test(u.color) ? u.color : colorFor(u.id);
  const agent = u.kind === "agent";
  const el = h("span", { class: `avatar avatar-md${agent ? " is-agent" : ""}`, title: agent ? `${u.name} (agent)` : u.name, style: { "--c": color } });
  if (u.avatar && /^https:\/\//.test(u.avatar)) el.appendChild(h("img", { src: u.avatar, alt: "" }));
  else el.textContent = initials(u.name);
  if (agent) el.appendChild(h("span", { class: "agent-badge" }, "AI"));
  return el;
}

/** A peer's awareness `user`, if it has the right shape. Peers are untrusted input. */
export function validPeerUser(u: unknown): { id: string; name: string; color: string; kind: "human" | "agent"; avatar?: string } | null {
  if (!u || typeof u !== "object") return null;
  const o = u as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id || typeof o.name !== "string") return null;
  const name = o.name.trim().slice(0, 80) || "Anonymous";
  const color = typeof o.color === "string" && COLOR_RE.test(o.color) ? o.color : colorFor(o.id);
  const kind = o.kind === "agent" ? "agent" : "human";
  const avatarUrl = typeof o.avatar === "string" && /^https:\/\//.test(o.avatar) ? o.avatar : undefined;
  return { id: o.id, name, color, kind, ...(avatarUrl ? { avatar: avatarUrl } : {}) };
}

export function relativeTime(t: number | string | null | undefined): string {
  if (t === null || t === undefined) return "";
  const ms = typeof t === "number" ? t : Date.parse(t);
  if (!Number.isFinite(ms)) return "";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  const d = Math.round(hr / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(ms).toLocaleDateString();
}

export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "");

export function basename(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function displayName(path: string) {
  return basename(path).replace(/\.(md|markdown|mdx)$/i, "");
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

let toastHost: HTMLElement | null = null;
export function toast(message: string, kind: "info" | "error" = "info") {
  if (!toastHost) {
    toastHost = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.appendChild(toastHost);
  }
  const el = h("div", { class: `toast toast-${kind}` }, message);
  toastHost.appendChild(el);
  setTimeout(() => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 300);
  }, kind === "error" ? 6000 : 3500);
}

export function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
