// Back and forward through the notes opened in this tab: the browser's own history (each note is a pushState URL),
// with the app's place in it kept in history.state (browsers don't say whether there's a back or a forward), and
// each place's scroll and caret, put back when Back or Forward (the header's ‹ ›, ⌘[ / ⌘], the browser's) returns.

export interface Spot {
  /** The URL path it was taken at (a place whose URL changed since isn't put back). */
  path: string;
  scroll: number;
  sel: { anchor: number; head: number } | null;
}

/** At most this many places are remembered (scroll and caret); older ones go. */
const CAP = 100;
const KEY = "grimoire.nav.v1";

let idx = 0;
let top = 0;
let spots = new Map<number, Spot>();
let onChange = () => {};

function stateIndex(s: unknown): number | null {
  const n = (s as { nav?: unknown } | null)?.nav;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

function save() {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ top, spots: [...spots] }));
  } catch {}
}

/** This tab's place in its history, from the entry it's on (a reload keeps it) and what the tab kept. */
export function initNav(changed: () => void) {
  onChange = changed;
  try {
    window.history.scrollRestoration = "manual";
  } catch {}
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as { top?: unknown; spots?: unknown } | null;
    if (typeof raw?.top === "number") top = raw.top;
    if (Array.isArray(raw?.spots)) spots = new Map(raw.spots as [number, Spot][]);
  } catch {}
  const at = stateIndex(window.history.state);
  if (at === null) {
    // a fresh entry (typed in, a link from elsewhere): a new place after the last one this tab knew
    idx = spots.size || top ? top + 1 : 0;
    top = idx;
    dropAfter(idx);
    window.history.replaceState({ ...(window.history.state ?? {}), nav: idx }, "", location.href);
  } else {
    idx = at;
    top = Math.max(top, idx);
  }
  save();
}

function dropAfter(i: number) {
  for (const k of spots.keys()) if (k > i || k <= i - CAP) spots.delete(k);
}

/** Going somewhere new: `url` after the current place; what was ahead goes. `leaving` is the current place's spot. */
export function navPush(url: string, leaving: Spot | null) {
  if (leaving) spots.set(idx, leaving);
  idx += 1;
  top = idx;
  dropAfter(idx);
  spots.delete(idx);
  window.history.pushState({ nav: idx }, "", url);
  save();
  onChange();
}

/** The current place under another URL (the same note, its canonical address). */
export function navReplace(url: string) {
  window.history.replaceState({ ...(window.history.state ?? {}), nav: idx }, "", url);
}

/**
 * The browser went back or forward (popstate): `leaving` is the spot of the place it left; the spot to put back
 * for where it is now, if one was kept.
 */
export function navPopped(leaving: Spot | null): Spot | null {
  if (leaving) spots.set(idx, leaving);
  const at = stateIndex(window.history.state);
  // an entry without a place (made outside the app): treat it as new
  idx = at ?? top + 1;
  top = Math.max(top, idx);
  save();
  onChange();
  const spot = spots.get(idx);
  return spot && spot.path === location.pathname ? spot : null;
}

export const canGoBack = () => idx > 0;
export const canGoForward = () => idx < top;

export function goBack() {
  if (canGoBack()) window.history.back();
}

export function goForward() {
  if (canGoForward()) window.history.forward();
}
