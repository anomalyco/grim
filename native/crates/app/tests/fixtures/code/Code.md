# Code blocks

TypeScript:

```ts
import { readFile } from "node:fs/promises";
/** Count a note's lines. */
export async function count(path: string): Promise<number> {
  const text = await readFile(path, "utf8"); // read it
  return text.split(/\r?\n/).length + 0x1f;
}
```

```rust
#[derive(Debug)]
pub struct Note<'a> { title: &'a str }
fn main() {
    let n = Note { title: "hi" };
    println!("{n:?} {}", 1_000u32);
}
```

```python
@dataclass
class Note:
    """A note."""
    def words(self, n: int = 3) -> list:
        return [w for w in self.title.split() if len(w) > n]  # long words
```

```json
{ "name": "grimoire", "version": 1.5, "tags": ["notes"], "draft": false, "parent": null }
```

```sh
#!/usr/bin/env bash
for f in *.md; do echo "file: $f" | grep -v '^#' > "$f.out"; done
export PATH="$HOME/.cargo/bin:$PATH"
```

```diff
@@ -1,3 +1,3 @@
 # Notes
-old line
+new line
```

```patch
--- a/src/main.rs
+++ b/src/main.rs
@@ -10,2 +10,2 @@ fn main() {
-    let x = 1;
+    let x = 2;
```

```
no language: plain "text" // stays ink
```
