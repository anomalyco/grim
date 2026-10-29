# Note typography

The note's type and colours are the same in the web app and the Mac app, value for value. Each app keeps them in one place:

- **Web:** the `.mde` block at the top of [`src/client/editor-rs/editor.css`](../src/client/editor-rs/editor.css) (CSS variables `--mde-*`).
- **Mac:** the top of `native/crates/app/src/theme.rs` (`TEXT`, `HEADING`, `BODY_LH`, `HEADINGS`, …).

Change a value in both. Every size, line height and padding is a whole pixel (point), so both apps put every line at the same place; on the web, line heights are unitless ratios that work out to those pixels, so smaller inline code and the link pencil keep their own leading inside the line.

Faces: San Francisco on Apple devices (SF Text below 20 px, SF Display above, picked by size), SF Mono for code, Inter elsewhere (`--font-*` in `app.css`; `sysfont.rs` on the Mac). No font-smoothing override on the web: the platform's default.

## Colours

| Token | Web | Mac | Value | Contrast on the paper |
| --- | --- | --- | --- | --- |
| Paper | `--mde-bg` | `PAPER` | `#fcfcfb` | |
| Body text, bullets, numbers, checkboxes | `--mde-text` | `TEXT` | `#36373d` | 11.6:1 |
| Headings, table heads | `--mde-heading` | `HEADING` | `#1d1e22` | 16.2:1 |
| Quotes, tags | `--mde-text-light` | `INK_LIGHT` | `#55565d` | 7.1:1 |
| Markers, checked tasks | `--mde-marker`, `--mde-checked` | `MARKER` | `#62626a` | 5.9:1 |
| Links | `--mde-link` | `LINK` | `#296d9a` | |
| Code background | `--mde-code-bg` | `CODE_BG` | `#f1f1f2` | |
| Rules, quote bar | `--mde-stroke` | `STROKE` | `#d4d4d8` | |
| Link pencil (hover) | `.chip` | `PENCIL` (`PENCIL_HOVER`) | `#a1a1aa` (`#52525b`) | |

## Type scale

| Element | Size | Line height | Weight | Padding above / below |
| --- | --- | --- | --- | --- |
| Body, lists, quotes, table cells | 16 | 27 (1.6875) | 400 | |
| H1 | 32 | 36 | 700 | 24 / 4 |
| H2 | 24 | 30 | 600 | 20 / 2 |
| H3 | 18 | 24 | 600 | 12 / 2 |
| H4 | 16 | 22 | 600 | 10 / 2 |
| H5, H6 | 13 | 16 | 600 | 8 / 2 |
| Inline code | 0.875 em (14 in body text) | its line's | 400 | background 3 px past the text each side, taking no room in the line |
| Code block | 13.5 | 22 | 400 | 10 above and below, 16 left and right, radius 6 |
| Table cells | 16 | 27 | 400 (head 600) | 5 above and below, 20 between columns, a 1 px rule under each row |
| Note title (header) | 14 | 17 | 500 | |

A blank line between blocks is one body line (27). With the heading padding that gives a heading more room above than below (H2: 47 above, 29 below).

Lists indent one gutter (33) per level; the bullet (5×5) and the checkbox (14×14) sit centred on the first line. A rule's 1 px line sits in a 27 px line. The quote bar is 3 px wide, 12 px into the gutter, inset 0.15 em top and bottom.

## Checking parity

Open the same note in both apps at the same window size and compare each line's top and height: on the web from `getBoundingClientRect` (and `getComputedStyle`), on the Mac from Rune's `--tree` output (`grimoire NOTE.md --snap out.png --size 1100x2600 --scale 2 --tree out.json`). Known differences that are the text engines', not the styles: Chrome doesn't apply SF Mono's tracking table (CoreText, Safari and the Mac app do), so code is a little narrower in Chrome; heading glyphs can differ by a fraction of a pixel in advance. Lines with inline code or a link pencil need Rune's span line height (a span of its own size keeps the paragraph's leading ratio, as CSS's unitless `line-height`); without it those lines are 1 px taller on the Mac.
