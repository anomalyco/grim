# Signing in, and what happens to workspaces

The web app and Grimoire for Mac follow the same rules. Each server has its own account, so on the Mac the rules are
per server (most people only use one).

All of this is for servers with sign-in on (`SIGN_IN=on`: grimnotes.app, staging, and self-hosted servers that turn it
on). A server with sign-in off (the default for self-hosting; `/api/config` and `/api/server` say `signIn: false`) has
no accounts: there is nothing to sign in to, and every visitor may do everything under its own guest name.

- **Web:** no Sign in button, sign-in prompt or dialog. The sidebar's bottom row is the browser's guest name; its menu
  says "<host> · No sign-in" and has only **Change name…** (which renames the browser's guest identity). The switcher
  lists the workspaces this visitor joined on the server.
- **Mac:** connecting needs no token (the app checks `/api/server` first, and remembers the server as "no sign-in");
  its remote workspaces show without signing in, and nothing opens the sign-in dialog. The account row says
  "<host> · No sign-in" with only **Change name…** (the app's guest name). Sign out (everywhere) leaves such servers
  alone. Local folders are unchanged.

## Signing in

- **Web:** Sign in goes straight to Google (`/auth/google?next=…`, PKCE S256, state and nonce in an HttpOnly cookie
  under `/auth`). There's no page of ours in between. The sign-in prompts that explain why ("Sign in to create notes")
  are still dialogs. A self-hosted server that also offers GitHub shows the choice.
- **Mac** (OAuth for native apps, RFC 8252): Sign in opens a dialog ("Continue in your browser…", Cancel) and opens
  the system browser at
  `/auth/google/start?client=mac&redirect_uri=http://127.0.0.1:<random port>/callback&state=<random>&code_challenge=<S256>&code_challenge_method=S256`.
  That page goes straight to Google. After Google, the server redirects to the loopback with a one-time `code` and the
  app's `state`. A failure (cancelled, unverified email) comes back as `error` and `error_description`.
  - The app's listener is bound to 127.0.0.1 only. It takes the one callback that carries its state, then closes. It
    gives up after 5 minutes, or when the user presses Cancel.
  - The app exchanges the code over HTTPS (`POST /auth/token {code, code_verifier}`) for
    `{token, token_id, account, login, email}`, then answers the browser tab with "You're signed in — you can close
    this tab". The dialog closes. On an error, the dialog shows it with Retry.
  - The code is single-use, lasts 60 s, is bound to the PKCE challenge and is stored hashed (`connect_codes`). The
    browser is never signed in by the app's sign-in.
  - Redirect URIs are checked on the server. For apps, only `http://127.0.0.1:<port>/callback` or
    `http://[::1]:<port>/callback` is accepted. For the web, `next` must be a same-origin `/app` path, and Google's
    redirect URI is the server's own `/auth/google/callback`.
- **Tokens** (`gmt_…`) are stored hashed on the server and sent only as `Authorization: Bearer` (REST and WebSockets)
  to the origin they were issued for.
  - On the Mac they live in the Keychain only: a generic password, service "Grimoire", account = the server's origin,
    accessible after first unlock on this device only. They never go in files, logs, URLs or caches.
  - A token unused for 90 days stops working; using it keeps it alive. A 401 drops it, and the app shows signed out.
  - `DELETE /api/tokens/:id` revokes one.

## Workspaces and accounts

1. **Signing in as another account** while one is signed in (another email) signs the previous one out completely
   first:
   - its token or session is revoked on the server and removed from the device;
   - its sockets close;
   - its remote workspaces leave the sidebar and switcher;
   - its cached notes are deleted.

   The new account then sees only its own workspaces. On the web, signing in ends the browser's previous session of
   another account on the server (`loginWithSession`). On the next page load, the previous account's local data goes
   (`grimoire.account.v1`): last notes, folders' open state, folded headings, image sizes, kept edits.
2. **Signing in from a guest** keeps the guest's remote workspaces and adds them to the account on the server
   (`POST /api/workspaces/join-many`), so they're in its list everywhere.
3. **Local folders** (the Mac's folders on disk; the web's scratch note) never change with signing in or out.
4. **Signing out** is the first half of rule 1, for every remote workspace:
   - Mac: every server's token is revoked and removed from the Keychain. All remote workspaces and their caches go.
     The app switches to the most recent local folder. With none, it shows "No workspaces" with "Open a folder…" and
     "Sign in".
   - Web: the session ends. The account's local data and the list of workspaces on other servers go, and the page
     goes home.
