# Grim review kit

Build pages people can review: stacks of diffs, screenshots, before/after comparisons, questions. In Grim for Mac's
side panel the reviewer can draw on any diff or image, pin comments, answer questions, tick a checklist, and **send
the review back to the agent session** that wrote the page (comments with their file and line, plus PNGs of what was
drawn).

## Use it

Write `artifacts/<name>/index.html` in the workspace, with your data files beside it, and link it from a note
(`[Review: share links](artifacts/share-links/index.html)`). Include the kit with one line; Grim serves it, so don't
copy it:

```html
<!doctype html>
<meta charset="utf-8">
<title>Share links</title>
<script src="/_kit/review.js" defer></script>

<h1>Share links</h1>
<p>What changed and why, in two sentences.</p>

<grim-note kind="question">Should links expire after 7 days, or never?</grim-note>

<grim-images>
  <grim-compare before="before.png" after="after.png" caption="Share dialog" mode="swipe"></grim-compare>
  <img src="link-tab.png" alt="The new link tab">
</grim-images>

<grim-diff-stack src="changes.patch" heading="Code"></grim-diff-stack>
```

`changes.patch` is any unified diff (`git diff` output, several files). Paths are relative to the page.

## Elements

| Element | What it shows | Data |
| --- | --- | --- |
| `<grim-diff-stack>` | Many diffs, one after another, with a file list (side column when wide, **Files** menu when narrow), +/− counts, Expand/Collapse all, Unified/Split, per-file **Viewed** | `src="x.patch"` (or `.diff`); `src="files.json"` (`[{file, diff}]`, `[{file, before, after, note}]`, `[{file, beforeSrc, afterSrc}]`); inline `<script type="text/x-diff">…</script>`; or `<grim-diff>` children. `heading="…"` |
| `<grim-diff>` | One file: header, line numbers, syntax colours, changed words, collapsible | `src="one.diff"`; `before-src`/`after-src`; inline `<script type="text/x-diff">`, or `<script type="text/x-before">` + `<script type="text/x-after">`. `file="path/name.ts"` (names it, picks the colours), `mode="split"`, `collapsed`, `context="5"` or `"all"` (before/after only), `note="…"` or a `<grim-note>` child |
| `<grim-images>` | A grid of screenshots with captions; click to enlarge (← → to step through) | `<img src alt>` children (alt is the caption), `<figure><img><figcaption>`, `<grim-compare>` children, or `src="images.json"` (`[{src, caption}]` or `[{before, after, caption}]`). `columns="2"`, `layout="row"` |
| `<grim-compare>` | Before/after: **Side by side** or **Swipe** (a slider) | `before="a.png" after="b.png" caption="…" mode="swipe"`, `before-label`/`after-label` |
| `<grim-section>` | A titled part of the page | `heading="…" subtitle="…"`, any HTML inside |
| `<grim-note>` | A callout | `kind="info"` (default), `"question"` (the reviewer gets an answer box, sent with the review), `"decision"`, `"warning"`, `"done"`; `label="…"` |
| `<grim-checklist>` | Items the reviewer ticks (sent with the review) | `<li>` children, `heading="…"` |
| `<grim-video>` | A video with a caption | `src="demo.mp4" caption="…" poster="…"` |

Plain HTML works around them (`<h1>`, `<p>`, `<code>`, tables): the kit gives the page Grim's type and colours.

## Examples

Before/after text, no diff file needed:

```html
<grim-diff file="wrangler.toml">
  <grim-note>Only staging gets the new table.</grim-note>
  <script type="text/x-before">
    compatibility_date = "2026-08-01"
  </script>
  <script type="text/x-after">
    compatibility_date = "2026-10-01"
  </script>
</grim-diff>
```

A stack from JSON, with a note per file:

```json
[
  { "file": "src/server/links.ts", "diff": "@@ -1,2 +1,3 @@\n a\n+b\n c\n", "note": "New module." },
  { "file": "README.md", "beforeSrc": "old/README.md", "afterSrc": "new/README.md" }
]
```

Three screenshots in two columns:

```html
<grim-images columns="2">
  <img src="desktop.png" alt="Desktop">
  <img src="mobile.png" alt="Phone, 390 px">
  <img src="dark.png" alt="Dark mode">
</grim-images>
```

## Reviewing

- **Annotate** (toolbar at the bottom): pen, highlighter, comment pins (click a spot, type, ⌘↩), five colours, undo
  (⌘Z), clear. Works on every diff (anchored to the line, so it survives collapsing and Split) and every image
  (including the swipe view and the enlarged view).
- **Review** opens the tray: every annotation grouped by file or image, an overall comment, and Send for one group or
  for everything.
- **Send** (in Grim for Mac) delivers the review to the session that wrote the page, as a prompt with each comment's
  file, line and code, a diff excerpt, the answers and checklist, and a PNG per annotated region. Annotations are kept
  in the panel until they're sent. In a plain browser the button copies the review as Markdown instead.

## For hosts

`window.grimReview` is the API: `send()`, `buildPayload()`, `hostResult({ok, session, error})`. Inside Grim the page
posts `{type: "review", payload}` to `window.webkit.messageHandlers.grim`; the payload is
`{type: "grim-review", version: 1, artifact: {url, path, title}, overall, items: [{kind: "diff" | "image", file,
lines: {new: [a, b], old}, linesLabel, comments: [{n, text, line, side, code}], strokes, excerpt, image: {name,
dataUrl, width, height}}], answers: [{question, answer}], checklists: [{title, items: [{text, checked}]}], markdown}`.
