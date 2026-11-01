// libopus for the experimental voice sessions (src/voice/opus.rs), linked statically: Homebrew's (`brew install
// opus`), or the folder in LIBOPUS_LIB_DIR.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=LIBOPUS_LIB_DIR");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let dirs = std::env::var("LIBOPUS_LIB_DIR").into_iter().chain(["/opt/homebrew/opt/opus/lib".to_string(), "/usr/local/opt/opus/lib".to_string()]);
    // the archive by its path: with `-lopus` the linker would take the dylib beside it
    match dirs.map(|d| std::path::Path::new(&d).join("libopus.a")).find(|a| a.exists()) {
        Some(a) => println!("cargo:rustc-link-arg={}", a.display()),
        None => println!("cargo:warning=libopus.a not found (brew install opus, or set LIBOPUS_LIB_DIR)"),
    }
}
