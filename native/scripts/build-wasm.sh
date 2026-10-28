#!/usr/bin/env bash
# Build crates/editor-wasm for the web: release wasm (size-optimized, LTO), wasm-bindgen --target web,
# wasm-opt -Oz when available. Output: target/editor-wasm-pkg/ (editor_wasm.js, editor_wasm_bg.wasm, .d.ts).
# Optional: DEST=user@host:/path/to/pkg/ copies the output there with scp.
#
# Needs: rustup target add wasm32-unknown-unknown; cargo install --locked wasm-bindgen-cli --version <the
# wasm-bindgen version pinned in crates/editor-wasm/Cargo.toml>; wasm-opt (binaryen) optional.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

out=target/editor-wasm-pkg
want=$(sed -n 's/^wasm-bindgen = "=\(.*\)"/\1/p' crates/editor-wasm/Cargo.toml)
have=$(wasm-bindgen --version | awk '{print $2}')
if [ "$want" != "$have" ]; then
  echo "wasm-bindgen-cli $have != crate's $want: cargo install --locked wasm-bindgen-cli --version $want" >&2
  exit 1
fi

# size settings for the wasm build only (env overrides; the native release profile is untouched)
CARGO_PROFILE_RELEASE_OPT_LEVEL=z \
CARGO_PROFILE_RELEASE_LTO=true \
CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 \
CARGO_PROFILE_RELEASE_PANIC=abort \
CARGO_PROFILE_RELEASE_STRIP=true \
  cargo build -p editor-wasm --target wasm32-unknown-unknown --release

rm -rf "$out"
wasm-bindgen --target web --out-dir "$out" target/wasm32-unknown-unknown/release/editor_wasm.wasm
if command -v wasm-opt >/dev/null; then
  wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals \
    "$out/editor_wasm_bg.wasm" -o "$out/editor_wasm_bg.wasm.opt"
  mv "$out/editor_wasm_bg.wasm.opt" "$out/editor_wasm_bg.wasm"
else
  echo "(wasm-opt not found: skipped)"
fi

raw=$(wc -c <"$out/editor_wasm_bg.wasm" | tr -d ' ')
gz=$(gzip -9c "$out/editor_wasm_bg.wasm" | wc -c | tr -d ' ')
echo "editor_wasm_bg.wasm: $raw bytes raw, $gz bytes gzip -9"

if [ -n "${DEST:-}" ]; then
  scp "$out"/editor_wasm.js "$out"/editor_wasm_bg.wasm "$out"/editor_wasm.d.ts "$out"/editor_wasm_bg.wasm.d.ts "$DEST"
fi
