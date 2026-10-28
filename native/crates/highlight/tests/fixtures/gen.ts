// Writes expected.json: @pierre/highlights 0.3.0's own tokens for the snippets and edits below
// (`LiveTokenizer.getLineRecords`, one [token name, text] run per record).
// With the npm package unpacked at $HL (npm pack @pierre/highlights@0.3.0; tar xf):
//   HL=/path/to/package bun gen.ts > expected.json
const HL = process.env.HL ?? "/tmp/opencode/hl/package";
const { LiveTokenizer, tokenNames } = await import(`${HL}/dist/default.js`);
const { pierreLight } = await import(`${HL}/dist/themes.js`);

const snippets: [string, string][] = [
  ["ts", `import { readFile } from "node:fs/promises";
// Read a note — and count its lines 🙂
export async function count(path: string): Promise<number> {
  const text = await readFile(path, "utf8");
  /* multi-line
     comment */
  return text.split(/\\r?\\n/).length + 0x1f;
}
class Box<T> { constructor(private value: T) {} }
const é = \`tpl \${1 + 2} done\`;`],
  ["rust", `use std::collections::HashMap;
/// Doc comment
#[derive(Debug, Clone)]
pub struct Note<'a> { title: &'a str, tags: Vec<String> }
impl<'a> Note<'a> {
    pub fn new(title: &'a str) -> Self {
        let r = r#"raw "string""#;
        Self { title, tags: vec![] } // ünïcode
    }
}
fn main() { println!("{}", 1_000u32 as f64 * 2.5e3); }`],
  ["python", `import os
from typing import Optional

@dataclass
class Note:
    """A note — docstring."""
    title: str = "untitled"

    def words(self, n: int = 3) -> Optional[list]:
        # comment ✓
        return [w for w in self.title.split() if len(w) > n] or None

print(f"{os.getcwd()!r} {1_000 + 0x10}")`],
  ["json", `{
  "name": "grimoire",
  "version": 1.5e2,
  "tags": ["notes", "markdown"],
  "nested": { "ok": true, "none": null, "esc": "a\\"b\\u00e9" }
}`],
  ["sh", `#!/usr/bin/env bash
set -euo pipefail
# build and copy
for f in *.md; do
  echo "file: $f \${HOME}" | grep -v '^#' > "$f.out"
done
if [ -n "$1" ]; then exit 1; fi
export PATH="$HOME/.cargo/bin:$PATH"`],
  ["diff", `diff --git a/notes.md b/notes.md
index 3b18e51..a9c2d2f 100644
--- a/notes.md
+++ b/notes.md
@@ -1,4 +1,4 @@
 # Notes
-old line
+new line
 unchanged`],
  ["patch", `From 1a2b3c Mon Sep 17 00:00:00 2001
Subject: [PATCH] Fix
---
 src/main.rs | 2 +-
@@ -10,7 +10,7 @@ fn main() {
-    let x = 1;
+    let x = 2;
     run(x);`],
];

// Edits applied in order (UTF-16 line/character ranges), each followed by the expected tokens.
const editCases: { lang: string; code: string; edits: { range: any; newText: string }[] }[] = [
  {
    lang: "ts",
    code: "const a = 1;\nconst b = \"two\";\nfunction f() { return a + b; }\n",
    edits: [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "/* " },
      { range: { start: { line: 1, character: 16 }, end: { line: 1, character: 16 } }, newText: " */" },
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "" },
      { range: { start: { line: 1, character: 5 }, end: { line: 2, character: 8 } }, newText: "x = 'é🙂'\nlet" },
      { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } }, newText: "// new\n" },
    ],
  },
  {
    lang: "python",
    code: "x = 1\ny = 2\n",
    edits: [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '"""\n' },
      { range: { start: { line: 2, character: 5 }, end: { line: 2, character: 5 } }, newText: '\n"""' },
    ],
  },
];

function lines(t: any) {
  const out: [string, string][][] = [];
  for (let l = 0; l < t.lineCount; l++) {
    const text = t.getLineText(l);
    const { format, data } = t.getLineRecords(l);
    const row: [string, string][] = [];
    let start = 0;
    const n = format === "wide32" ? data.length / 2 : data.length;
    for (let r = 0; r < n; r++) {
      const end = format === "wide32" ? data[r * 2] : data[r] & 0xffffff;
      const id = format === "wide32" ? data[r * 2 + 1] : data[r] >>> 24;
      if (end > start) {
        row.push([tokenNames[id], text.slice(start, end)]);
        start = end;
      }
    }
    if (start < text.length) row.push(["none", text.slice(start)]);
    out.push(row);
  }
  return out;
}

const j = (v: unknown) => JSON.stringify(v);
const rows = (ls: unknown[]) => "[\n" + ls.map((r) => "      " + j(r)).join(",\n") + "\n    ]";
const snippetsOut = snippets.map(([lang, code]) => {
  const t = new LiveTokenizer({ lang, code, theme: pierreLight });
  return `    {"lang": ${j(lang)}, "code": ${j(code)},\n    "lines": ${rows(lines(t))}}`;
});
const editsOut = editCases.map((c) => {
  const t = new LiveTokenizer({ lang: c.lang, code: c.code, theme: pierreLight });
  const steps = c.edits.map((e) => {
    t.applyEdits([e]);
    return `      {"edit": ${j(e)}, "text": ${j(t.getText())},\n      "lines": ${rows(lines(t))}}`;
  });
  return `    {"lang": ${j(c.lang)}, "code": ${j(c.code)}, "steps": [\n${steps.join(",\n")}\n    ]}`;
});
console.log(`{\n  "version": "0.3.0",\n  "snippets": [\n${snippetsOut.join(",\n")}\n  ],\n  "edits": [\n${editsOut.join(",\n")}\n  ]\n}`);
