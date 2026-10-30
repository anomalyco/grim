# The Mac app download (experimental)

The landing page's **Download macOS app** button (src/client/landing/home.ts) opens a dialog explaining the build, and
its **Download** links to **https://grimnotes.app/download/Grim-macos.zip**.

- **Where it lives:** the zip is an asset on the `mac` prerelease of anomalyco/grim
  (`https://github.com/anomalyco/grim/releases/download/mac/Grim-macos.zip`). The site answers `/download/Grim-macos.zip`
  with a 302 there (src/server/app.ts; on Workers it is a `run_worker_first` path in wrangler.jsonc). Nothing large is in
  the repo; the constants are in src/shared/mac-download.ts.
- **What it is:** grimoire-native's `dist/Grim.app`, ad-hoc signed (not with a Developer ID) and not notarised, so
  Gatekeeper warns on first open. arm64 only; `LSMinimumSystemVersion` is 13.0 (packaging/Info.plist). It connects to
  grimnotes.app by default. If any of that changes, update the dialog's text.

## Publishing a new build

On the Mac, in grimoire-native:

```bash
scripts/bundle.sh                                    # release build → dist/Grim.app
ditto -c -k --keepParent dist/Grim.app Grim-macos.zip  # ditto keeps the bundle's metadata
```

Copy the zip to a machine with `gh` signed in to anomalyco/grim, then, in this repo:

```bash
scripts/publish-mac.sh Grim-macos.zip
```

It replaces the asset on the `mac` release (or creates the release), so the download URL doesn't change and no deploy is
needed.
