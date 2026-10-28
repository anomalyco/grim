// What a Durable Object exposes over RPC must be plain data: no Code Storage `Repo`/`GitStorage` (they carry the
// private key), and no store, room or runtime that holds one. This lint reads the declarations tsc emits for
// src/workers (inferred return types written out) and fails on any public member of a DurableObject class whose
// signature names one of those types. TS-`private` methods are still callable over RPC, so their source signatures
// are checked too (only `#private` members are off the RPC surface). Used by scripts/check-workers.ts.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Types that hold the Code Storage key, or a store/room/runtime that does. */
export const FORBIDDEN_TYPES = [
  "Repo",
  "GitStorage",
  "GitStore",
  "CodeStorageStore",
  "CachedHeadStore",
  "HeadCachingStore",
  "RoutedStore",
  "MemoryStore",
  "LocalGitStore",
  "RoomManager",
  "Room",
  "WorkspaceRuntime",
  "RuntimeMap",
  "RepoService",
  "RoomStorage",
  "DoRoomStorage",
];
const FORBIDDEN = new RegExp(`\\b(${FORBIDDEN_TYPES.join("|")})\\b`);

export interface SurfaceProblem {
  file: string;
  cls: string;
  member: string;
  type: string;
}

/** Problems in one module: its emitted declarations (`dts`) and its source (for TS-private methods). */
export function surfaceProblems(file: string, dts: string, source: string): SurfaceProblem[] {
  const problems: SurfaceProblem[] = [];
  const text = stripComments(dts);
  const head = /export\s+declare\s+class\s+(\w+)\s+extends\s+DurableObject\b[^{]*\{/g;
  for (let m; (m = head.exec(text)); ) {
    const cls = m[1]!;
    const body = block(text, m.index + m[0].length - 1);
    for (const member of members(body)) {
      if (member.startsWith("#") || /^constructor\s*\(/.test(member)) continue;
      const priv = /^(?:private|protected)\s+(?:static\s+)?(?:readonly\s+)?(\w+)/.exec(member);
      if (priv) {
        // declarations drop TS-private types: read the method's signature from the source
        const sig = privateSignature(stripComments(source), cls, priv[1]!);
        const hit = sig && FORBIDDEN.exec(sig);
        if (hit) problems.push({ file, cls, member: priv[1]!, type: hit[1]! });
        continue;
      }
      const hit = FORBIDDEN.exec(member);
      if (hit) problems.push({ file, cls, member: /^(?:static\s+|readonly\s+|get\s+|set\s+|async\s+)*([\w$]+)/.exec(member)?.[1] ?? member.slice(0, 40), type: hit[1]! });
    }
  }
  return problems;
}

/** Emits src/workers' declarations with tsc and checks every src/workers/*-do.ts. */
export function checkDoSurface(root: string): SurfaceProblem[] {
  const out = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "grim-do-surface-"));
  try {
    const tsc = Bun.spawnSync(["bunx", "tsc", "-p", "tsconfig.workers.json", "--noEmit", "false", "--declaration", "--emitDeclarationOnly", "--rootDir", ".", "--outDir", out], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (tsc.exitCode !== 0) throw new Error(`tsc --declaration failed (exit ${tsc.exitCode}):\n${tsc.stdout}${tsc.stderr}`);
    const dir = join(root, "src/workers");
    const files = readdirSync(dir).filter((f) => /-do\.ts$/.test(f));
    if (files.length === 0) throw new Error("no src/workers/*-do.ts");
    return files.flatMap((f) => surfaceProblems(`src/workers/${f}`, readFileSync(join(out, "src/workers", f.replace(/\.ts$/, ".d.ts")), "utf8"), readFileSync(join(dir, f), "utf8")));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/** The text inside the braces opening at `open`. */
function block(s: string, open: number): string {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return s.slice(open + 1, i);
  }
  throw new Error("unbalanced braces in declarations");
}

/** A class body's members, split on top-level `;`. */
function members(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{" || c === "(" || c === "[" || c === "<") depth++;
    else if ((c === "}" || c === ")" || c === "]" || c === ">") && body[i - 1] !== "=") depth--;
    else if (c === ";" && depth === 0) {
      out.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (body.slice(start).trim()) out.push(body.slice(start).trim());
  return out.filter(Boolean);
}

/** `private name(…): T` in class `cls` of the source, up to its body; null for fields and missing members. */
function privateSignature(source: string, cls: string, name: string): string | null {
  const c = new RegExp(`class\\s+${cls}\\b[^{]*\\{`).exec(source);
  if (!c) return null;
  const body = block(source, c.index + c[0].length - 1);
  const m = new RegExp(`(?:private|protected)\\s+(?:static\\s+)?(?:async\\s+)?(?:get\\s+|set\\s+)?${name}\\s*(?:<[^>]*>)?\\(`).exec(body);
  if (!m) return null;
  // the parameters and return annotation: everything up to the body's opening brace at depth 0
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(" || ch === "<" || ch === "[") depth++;
    else if ((ch === ")" || ch === ">" || ch === "]") && body[i - 1] !== "=") depth--;
    else if (ch === "{" && depth === 0) return body.slice(m.index, i);
  }
  return body.slice(m.index);
}
