// A DOM for the Rust editor shell's unit tests (happy-dom), installed as globals while a test file runs.
import { afterAll } from "bun:test";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/", width: 900, height: 700 });
const names = [
  "window",
  "document",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLDivElement",
  "HTMLImageElement",
  "Text",
  "Range",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "InputEvent",
  "KeyboardEvent",
  "MouseEvent",
  "Event",
] as const;
const g = globalThis as Record<string, unknown>;

/** Install the DOM globals for the calling test file (restored after it). Importing this module installs them once. */
export function installDom(): void {
  if (g.document === win.document) return;
  const saved = new Map<string, unknown>();
  for (const n of names) {
    saved.set(n, g[n]);
    const v = n === "window" ? win : (win as unknown as Record<string, unknown>)[n];
    g[n] = typeof v === "function" && /^[a-z]/.test(n) ? (v as Function).bind(win) : v;
  }
  afterAll(() => {
    for (const [n, v] of saved) g[n] = v;
  });
}

installDom();

export { win };
