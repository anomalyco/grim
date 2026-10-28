# Agent notes

## Committing and pushing

- Commit with the default git identity (the owner, from the git config). Don't override it (no `-c user.name=…`, no `--author`).
- After each commit, push to `origin main` (https://github.com/anomalyco/grim) with `push origin main` (= `git push --no-verify`). Never force-push.
- Native (Mac app) changes reach grim only through `scripts/sync-native.sh`, which pulls the Mac working repo's `main` into `native/` and pushes. Don't commit to `native/` directly here.
