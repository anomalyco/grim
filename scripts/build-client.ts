// `bun run build:client [--watch]`: fonts and the wasm editor engine into dist/, then the client bundle.
// The engine (src/client/editor-rs/pkg) goes to dist/editor-rs/<content hash>/ so it can be cached forever
// (the server marks /dist/editor-rs/<hash>/ immutable and sends the .gz copies made here); the bundle learns the
// hash through --define. The code highlighter's wasm (@pierre/highlights, loaded on demand by editor-rs/code-live.ts)
// goes to dist/highlights/<content hash>/ the same way.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url).pathname;
const pkg = root + "src/client/editor-rs/pkg/";
const files = ["editor_wasm.js", "editor_wasm_bg.wasm"];

mkdirSync(root + "dist/editor-rs", { recursive: true });
cpSync(root + "src/client/fonts", root + "dist/fonts", { recursive: true });
let hash = "";
if (files.every((f) => existsSync(pkg + f))) {
  const h = new Bun.CryptoHasher("sha256");
  for (const f of files) h.update(readFileSync(pkg + f));
  hash = h.digest("hex").slice(0, 16);
  mkdirSync(root + `dist/editor-rs/${hash}`, { recursive: true });
  for (const f of files) {
    cpSync(pkg + f, root + `dist/editor-rs/${hash}/${f}`);
    // served pre-compressed (the server doesn't compress on the fly)
    writeFileSync(root + `dist/editor-rs/${hash}/${f}.gz`, Bun.gzipSync(readFileSync(pkg + f), { level: 9 }));
  }
}
const hlWasm = root + "node_modules/@pierre/highlights/dist/highlights.wasm";
const hlBytes = readFileSync(hlWasm);
const hlHash = new Bun.CryptoHasher("sha256").update(hlBytes).digest("hex").slice(0, 16);
mkdirSync(root + `dist/highlights/${hlHash}`, { recursive: true });
writeFileSync(root + `dist/highlights/${hlHash}/highlights.wasm`, hlBytes);
writeFileSync(root + `dist/highlights/${hlHash}/highlights.wasm.gz`, Bun.gzipSync(hlBytes, { level: 9 }));
// older builds stay a week for pages still running a previous bundle
const week = Date.now() - 7 * 24 * 3600e3;
for (const [dir, keep] of [["editor-rs", hash], ["highlights", hlHash]]) {
  for (const e of readdirSync(root + "dist/" + dir)) {
    const p = root + `dist/${dir}/` + e;
    if (e !== keep && (!/^[0-9a-f]{16}$/.test(e) || statSync(p).mtimeMs < week)) rmSync(p, { recursive: true, force: true });
  }
}

const args = ["build", "src/client/main.ts", "--outdir", "dist", "--target", "browser", "--splitting", "--minify", "--sourcemap=linked"];
const proc = Bun.spawn(["bun", ...args, "--define", `__WASM_HASH__=${JSON.stringify(hash)}`, "--define", `__HL_WASM_HASH__=${JSON.stringify(hlHash)}`, ...process.argv.slice(2)], { cwd: root, stdio: ["inherit", "inherit", "inherit"] });
process.exit(await proc.exited);
