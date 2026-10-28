import { structuredPatch } from "diff";

/** A git-style unified diff of one file (`before` null: a new file; `after` null: deleted). "" when nothing changed. */
export function unified(path: string, before: string | null, after: string | null): string {
  const patch = structuredPatch(`a/${path}`, `b/${path}`, before ?? "", after ?? "", "", "", { context: 3 });
  if (!patch.hunks.length && before !== null && after !== null) return "";
  const out = [
    `diff --git a/${path} b/${path}`,
    ...(before === null ? ["new file mode 100644"] : after === null ? ["deleted file mode 100644"] : []),
    `--- ${before === null ? "/dev/null" : `a/${path}`}`,
    `+++ ${after === null ? "/dev/null" : `b/${path}`}`,
  ];
  for (const h of patch.hunks) {
    // Like git: an empty side starts at the line before.
    out.push(`@@ -${h.oldLines ? h.oldStart : h.oldStart - 1},${h.oldLines} +${h.newLines ? h.newStart : h.newStart - 1},${h.newLines} @@`, ...h.lines);
  }
  return out.join("\n") + "\n";
}
