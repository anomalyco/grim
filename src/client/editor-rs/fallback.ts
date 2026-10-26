// When the editor can't run (the wasm engine didn't load, or it trapped): the note's Markdown, read-only and
// unstyled, under a notice with a Reload button. There is no other editor to fall back to.

export const COULDNT_START = "The editor couldn't start. Reload to try again.";
export const STOPPED = "The editor ran into a problem. Reload to continue editing.";

/**
 * Show `text` (or what it resolves to; null: nothing to show) read-only in `container`, replacing what's there.
 * Returns a teardown.
 */
export function showFallback(container: HTMLElement, text: string | null | Promise<string | null>, message = COULDNT_START): () => void {
  const wrap = document.createElement("div");
  wrap.className = "mde mde-fallback";
  const notice = document.createElement("div");
  notice.className = "mde-notice";
  notice.setAttribute("role", "alert");
  const msg = document.createElement("span");
  msg.textContent = message;
  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "btn";
  reload.textContent = "Reload";
  reload.addEventListener("click", () => location.reload());
  notice.append(msg, reload);
  const pre = document.createElement("pre");
  pre.className = "mde-fallback-text";
  pre.tabIndex = 0;
  pre.setAttribute("aria-label", "Note text (read-only)");
  wrap.append(notice, pre);
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
