# First load

How a client starts (web: `src/client/index.html` + the boot section of `src/client/main.ts`; the Mac app should
match it). The rule: **two visual phases only**. A quiet splash, then the complete app in one frame. Nothing partial
in between, and nothing that moves afterwards.

## 1. Splash

- It shows on the first paint, before any script or app stylesheet. On the web it's inline HTML and CSS in
  index.html (`#splash`), placed before the stylesheets so they don't hold it back.
- The app background (`#fcfcfb`) with nothing on it. After 150 ms a small, muted, letter-spaced `GRIMOIRE`
  fades in, centred. No spinner, no progress, no "Loading…", no partial UI.
- It covers the app while the app renders underneath. It goes away in one frame (it's removed, with no fade).

## 2. Requests, all started at once

- With the page: `/api/config`, `/api/server`, `/api/me` (preloaded by the HTML), the editor engine (the wasm and
  its JS glue), and the Inter roman and italic fonts.
- As the first script runs: `/api/repos`. The workspace it will open comes from the URL (`/app/<ws>/<path>`), or
  else from the last note this browser opened. For that workspace, `/api/repos/<ws>` and `/api/repos/<ws>/tree`
  start, plus `/api/repos/<ws>/file?path=` when the note is known (from the URL, the workspace's last note, or the
  last note overall).
- `/api/workspaces` starts as soon as `/api/me` says the person is signed in.
- Whichever request needs one of these takes the one in flight. One that isn't taken within 10 s is stale and is
  asked again.

## 3. When the app shows

The splash goes once **all** of these are ready:

1. who I am (signed in, or a guest);
2. the workspace list, and the route decided (until then, nothing may say "No workspace" or "No workspaces yet");
3. the open workspace's tree;
4. the open note's text, from the HTTP read or the socket sync, whichever comes first. The read-only preview of
   the text counts. A note that can't open counts too, once its message shows (not found, no access, too large);
5. the editor engine;
6. the stylesheets, and the fonts: Inter roman, italic and bold, then, after one layout of the hidden app, the font
   faces its text asked for (`document.fonts.ready`);
7. for a note with a code fence, the highlighter (its chunk and wasm);
8. the note's images, decoded, so they have their size.

Then everything shows in the same frame.

- **Cap:** at 3 s after navigation start, the app shows with whatever is ready (as soon as the shell exists). The
  tree's placeholder is empty (`aria-busy`), not "Loading…". The note area shows the 2 px bar.
- **Errors** (server unreachable, a fatal `/api/me` error, no such workspace) show their existing screens at
  once. The home, start and scratch pages show as soon as they're rendered.

## 4. After it shows

- Swapping the read-only preview for the live editor keeps the same text, scroll, caret and layout, and the image
  boxes keep their size.
- No "Connecting…" while a note's text shows, until 3 s have passed. With nothing on screen it shows after 300 ms,
  as before.
- Things that arrive later appear without moving the layout:
  - presence dots and header avatars of people who weren't there at the reveal fade in over 0.3 s;
  - line authors (the margin, absolutely positioned) fade in over 0.3 s when the first blame arrives.
- Image sizes are remembered per URL in this browser (`grimoire.imageSizes.v1`, the latest 500), so an image's box
  has its size before the image loads.

## 5. Switching workspaces

The old workspace stays on screen until the new one's details, tree and note text are here (capped at 3 s). Then
the sidebar, header and note change in one frame. Nothing empty shows in between.

## Tests and numbers

- `test/e2e/first-load.mjs` samples the DOM on every animation frame from before the page parses. It checks the
  phases are exactly splash → complete app for: homepage → "View the notes" → demo, guest `/app`, `/app/demo`,
  signed-in `/app` (last note), and a direct note URL. It also checks the workspace switch and the cap.
  `BASE_URL=…` runs the guest cases against a deployed server (read-only).
- Time to the full app (local Bun, 60 ms RTT, 20 Mbit/s, cold cache; "settled" is when nothing changes any
  more):

  | case | before | after |
  | --- | --- | --- |
  | homepage → demo | 10 states, settled 615 ms | 2 states (+ the mark), 481 ms |
  | signed-in `/app` | 7 states, 593 ms | 449 ms |
  | direct note URL | 6 states, 610 ms | 447 ms |
