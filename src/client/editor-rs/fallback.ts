// When the editor can't run (the wasm engine didn't load, or it trapped): the note's Markdown, read-only and
// unstyled, under a notice with a Reload button. There is no other editor to fall back to.

export const COULDNT_START = "The editor couldn't start. Reload to try again.";
export const STOPPED = "The editor ran into a problem. Reload to continue editing.";
export const NOT_KEPT = "The editor ran into a problem and your unsaved edits couldn't be kept for the reload: copy them before reloading.";

export interface NoticeAction {
  label: string;
  run: () => void;
}

function notice(message: string, actions: NoticeAction[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "mde-notice";
  el.setAttribute("role", "alert");
  const msg = document.createElement("span");
  msg.textContent = message;
  el.append(msg);
  for (const a of actions) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn";
    b.textContent = a.label;
    b.addEventListener("click", () => a.run());
    el.append(b);
  }
  return el;
}

/** Put `text` on the clipboard (false if the browser refused). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.append(ta);
  ta.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

/** Save `text` as a file named `name`. */
export function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "Copy your unsaved text" and "Download .md" for `text` (`onCopied`: told whether the copy worked). */
export function unsavedActions(text: string, fileName: string, onCopied?: (ok: boolean) => void): NoticeAction[] {
  return [
    { label: "Copy your unsaved text", run: () => void copyText(text).then((ok) => onCopied?.(ok)) },
    { label: "Download .md", run: () => downloadText(fileName, text) },
  ];
}

/**
 * A notice above the editor about unsaved text that couldn't be merged: `message`, `actions` (copy, download,
 * discard, ...) and the text itself, read-only, folded under a summary.
 */
export function unsavedBanner(message: string, text: string, actions: NoticeAction[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "mde-fallback mde-unsaved";
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Show your unsaved text";
  const pre = document.createElement("pre");
  pre.className = "mde-fallback-text";
  pre.textContent = text;
  details.append(summary, pre);
  wrap.append(notice(message, actions), details);
  return wrap;
}

/**
 * Show `text` (or what it resolves to; null: nothing to show) read-only in `container`, replacing what's there.
 * Returns a teardown.
 */
export function showFallback(
  container: HTMLElement,
  text: string | null | Promise<string | null>,
  message = COULDNT_START,
  /** Shown before Reload (e.g. copying edits that couldn't be kept). */
  actions: NoticeAction[] = [],
): () => void {
  const wrap = document.createElement("div");
  wrap.className = "mde mde-fallback";
  const pre = document.createElement("pre");
  pre.className = "mde-fallback-text";
  pre.tabIndex = 0;
  pre.setAttribute("aria-label", "Note text (read-only)");
  wrap.append(notice(message, [...actions, { label: "Reload", run: () => location.reload() }]), pre);
  container.replaceChildren(wrap);
  let gone = false;
  const fill = (t: string | null) => {
    if (gone) return;
    // textContent: the Markdown is shown as is, never parsed as HTML
    pre.textContent = t ?? "";
    pre.hidden = !t;
  };
  if (typeof text === "string" || text === null) fill(text);
  else {
    pre.hidden = true;
    text.then(fill, () => fill(null));
  }
  return () => {
    gone = true;
    wrap.remove();
  };
}
