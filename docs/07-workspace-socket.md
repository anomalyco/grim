# One WebSocket per workspace (protocol v2): design

> Status: **design, not built** (2026-10-28). Owner decision: Grimoire moves from one WebSocket per note to **one WebSocket per workspace per tab / app instance**. Tasks CF-41…CF-45 in the coordinator note build it. Today's protocol (v1) is in [V1 architecture → WebSocket](05-v1-architecture.md#websocket-wsrepoidpathpath-session-cookie); hosting details are in [Grimoire on Cloudflare](06-cloudflare.md).
>
> Terminology: a **workspace** is one Git repo (`repoId`). A **channel** is one open note on a socket.

Principles: speed and efficiency come first; Bun and Cloudflare behave the same (one shared implementation, small host hooks); nothing waits on polling (every wait is on an event: a frame, a close, a wake).

- [Why](#why)
- [1. Endpoint and admission](#1-endpoint-and-admission)
- [2. Framing](#2-framing)
- [3. Messages](#3-messages)
- [4. Workspace events on the socket](#4-workspace-events-on-the-socket)
- [5. Hibernation](#5-hibernation)
- [6. Reconnect](#6-reconnect)
- [7. Migration](#7-migration)
- [8. Agents, MCP and the shell](#8-agents-mcp-and-the-shell)
- [9. Efficiency estimates](#9-efficiency-estimates)
- [Implementation shape](#implementation-shape)

## Why

Today every note switch is a new WebSocket: a TCP + TLS connection and an upgrade through the Worker. The Worker authenticates (D1 on an auth-cache miss), reads the workspace row (D1 on a cache miss), records the join, and forwards the upgrade to the WorkspaceDO. The tab also holds an SSE stream to the single global HubDO, which fans every event of every workspace out to every tab. An idle tab wakes its WorkspaceDO every 15 s for awareness renewals, plus once a minute for the safety alarm (CF-30). One socket per workspace removes the per-switch connect and admission. It carries the workspace events, so the tab doesn't need SSE. It also lets idle tabs go quiet.

## 1. Endpoint and admission

```
GET /ws?repo=<workspaceId>            (protocol v2: no path)
GET /ws?repo=<workspaceId>&path=<p>   (protocol v1: unchanged until CF-45)
```

- **Who:** exactly as today. A session cookie (same origin) or an app token (`Authorization: Bearer` or `?token=`). Guests use `anon`, `name` and `color` query parameters (`guestFromQuery`). A token never becomes a guest.
- **Admission** is `admitWorkspace` (app.ts) without the path step. Rejections stay upgrade-then-close, so browsers see the code:

| Close | When |
| --- | --- |
| 4401 | not signed in and not a valid guest; bad token |
| 4403 | cross-origin without a token |
| 4404 | unknown workspace (also sent later when the workspace is removed) |
| 1013 | try again: a transient failure in admission (D1 unavailable) |
| 1011 | unexpected server error |

- **Not-ready workspaces are admitted** (status `importing`, or `error`). Unlike v1, the socket is how the client learns the import status (`workspace` event, §4). Opening a note in a workspace that isn't ready fails per channel with 1013 (§3).
- **A signed-in join is recorded once per socket** (`recordJoin`), not once per note.
- **Workers:** the Worker admits once and forwards the upgrade to `WORKSPACE.getByName(repoId)`. The `X-Grim-Admission` header is always overwritten by the Worker. It now carries `{ v: 2, repoId, branch, status, participant, readOnly }`; v1 still carries `path`. The DO refuses an upgrade without an admission or for another workspace, as today. After this, **note switches never touch the Worker or D1**.
- **Bun:** `createApp`'s `Upgrader` gets a `workspace(req, decision)` method next to `note`. The socket's data is the admitted workspace, and its frames go to the same shared multiplexer the DO uses (see [Implementation shape](#implementation-shape)).

## 2. Framing

Every binary frame is:

```
varuint channel  ·  varuint type  ·  payload
└ new ─────────┘    └ the v1 frame, byte for byte ──┘
```

- **channel** is a lib0 varuint: 1 byte for channels 1–127.
  - `0` is the **socket channel**, for workspace-level control.
  - `1…` are note channels. The server assigns them on `open`.
- **type** and **payload** are exactly the v1 frame:
  - `0` y-protocols sync (step 1 / step 2 / update)
  - `1` y-protocols awareness
  - `2` control: a varString of JSON

  On a note channel the payload is byte-identical to v1, so the existing encoders and decoders are reused unchanged: the Rust engine (`editor-wasm`, the Mac collab crate), `Room.onMessage` and `Room` sends. The multiplexer only adds or strips the channel prefix.
- **Channel 0** accepts only type 2 (control JSON). Any other type there is ignored.
- **Unknown channels:** frames for a channel that isn't open on that socket are dropped silently, in both directions. Channel ids are **never reused on a socket** (a counter), so a late frame for a closed channel can't be mistaken for a new one.
- **Unknown fields and messages:** clients must ignore control messages with a `t` they don't know, and unknown fields, as in v1.
- **Text frames** are used only for the heartbeat: `"ping"` → `"pong"` (§3.6). Any other text frame is ignored.
- **Overhead:** 1 byte per frame.

## 3. Messages

`→` is client to server, `←` is server to client. `ch` is a channel id. All of these are control JSON (type 2) unless a frame type is named.

### 3.1 Socket channel (0)

| Dir | Message | Meaning |
| --- | --- | --- |
| ← | `{t:"welcome", v:2, user:{id,name,color,kind}, readOnly, status, error?, maxChannels:8, renewMs:300000, awarenessTimeoutMs:720000, pingMs:30000}` | The first frame after the upgrade. `readOnly` is for the whole workspace. `status` is the workspace status. The timings are the server's policy (§3.6); clients use them instead of constants. |
| → | `{t:"open", path, sv?, readOnly?, hidden?}` | Open a note. `sv` is the client's Yjs state vector, base64 (it is the payload of the sync step 1 the client would have sent), when it already has a document for this note. `readOnly` asks for a read-only channel (the effective value is `readOnly ‖ workspace readOnly`). `hidden` opens it as a prefetch (§3.4). |
| ← | `{t:"opened", req, path, ch, generation, readOnly}` | The channel exists. `req` is the `path` as sent and `path` is the cleaned one (`cleanPath`), so the client can match the reply. The channel's first frames follow at once, in this order on `ch`: the v1 `hello`, `blame` (if loaded), sync **step 2** for `sv` (or the whole document if there's no `sv`), sync step 1 (the server's state vector), and awareness. **One round trip from `open` to the note's text.** |
| ← | `{t:"error", req, path?, code, reason}` | The open failed. No channel exists. The codes are v1's close codes, as data: `4404` file not found, `4413` over 5 MB, `1013` retry (store unavailable, workspace not ready, room closed meanwhile), `1011` couldn't open, `4400` invalid path, `4429` too many channels. |
| → | `{t:"close", ch}` | Done with a note. The server removes the connection from the room (presence and awareness go at once). There is no reply. The client forgets `ch` right away. |
| → | `{t:"view", ch, hidden}` | Show or hide a channel (prefetch ↔ visible, §3.4). |
| ← | `{t:"tree", head}`, `{t:"presence", …}`, `{t:"saved", …}`, `{t:"workspace", …}` | Workspace events (§4). |

- Opening a path that's **already open on this socket** (or still opening: the repeat waits for the first) returns the same channel (`opened` again, with its current generation), applies the repeat's `hidden` (as a `view` would) and, if it has an `sv`, sends sync step 2 for it on the channel. No second hello, step 1 or awareness; `readOnly` stays as first opened. So `open` is idempotent and safe to retry.
  - **Closed while opening, then reopened** (prefetch a note, drop it, then click it before the first `opened`): the client couldn't `close` a channel it has no id for, so its next `open` of the path gets that same channel. Both `opened` replies name it: the first reflects the first open's `hidden`, the second comes after the repeat's `hidden` is applied. A client binds the first, sends a `view` if what it wants differs from what the first open asked, and ignores the second (it already holds that `ch`). The server's slot for the closed open is now the reopened channel's, so the client no longer counts it as in limbo against `maxChannels`.
- Opens are processed **in parallel** (a cold open waits on the store; other channels keep flowing). Replies may come out of order. That's why `req` and `path` are in the reply.

### 3.2 Note channels (1…)

Exactly v1, scoped to the channel:

- **Sync** (type 0): step 1, step 2 and update, both ways. Updates from read-only channels are ignored.
- **Awareness** (type 1): the y-protocols awareness update. The client owns at most `MAX_IDS_PER_CONN` client ids **per channel**, as per connection today. One engine per note means one client id per channel.
- **Control** (type 2):
  - server → client: `hello`, `status`, `external`, `blame` and `closed` (`deleted`/`renamed` with `to`/`removed`) as in v1;
  - client → server: `flush`;
  - new, server → client: `end` and `renew` (below).

New messages:

| Dir | Message | Meaning |
| --- | --- | --- |
| ← | `{t:"end", code, reason}` | The channel is over (the v1 socket close, as data). After it the server sends nothing more on `ch`, and the client drops `ch`. The codes are the v1 close codes, so the client keeps its v1 logic: `4000` after `closed` (deleted, renamed, removed: show it); **`1013` = reopen** (the room was discarded or reset, e.g. the demo reset (`reason:"reset"`); it closed meanwhile; or it woke with another generation). The client reopens with its `sv`, and the new `hello.generation` tells it whether to reset (v1 rule: another generation → throw the document away and remount). `4404`/`4413`/`1011` are the same as for `error`. |
| ← | `{t:"renew", ms}` | Change this channel's awareness renewal interval (§7: v1 peers in the room need 15 s). |

A channel's end never closes the socket, and one note's failure never affects the others.

### 3.3 Limits

- **8 open channels per socket** (`maxChannels`, server-enforced; the 9th open gets `4429`). This is enough for the visible note, a split view or a second Mac window, and a few prefetched neighbours. Clients keep an LRU and close the least recently shown **hidden** channel before opening a new one.
- **Open rate:** at most 32 opens per 10 s per socket (`OPEN_RATE_MAX`). Reopening a path whose channel was closed or ended on the same socket in the last 60 s (`REOPEN_FREE_MS`) isn't counted, so going back and forth between recent notes is free. Over the limit → `error 4429`. The web client counts the same way and stays under it: prefetches use at most half of the window (they're refused locally past that), and a note the user picks past the limit waits for the window instead of being refused. This stops a buggy client from cold-opening a whole tree; walking the tree with a neighbour prefetch is ~10 opens per 10 s.
- **Frame size and backpressure:** as today (16 MB per frame; on Bun a socket over `MAX_BUFFERED` is closed 1013, and the client reconnects and resyncs every channel).
- **Sockets per workspace per client:** one per tab or app instance (the client keeps it). The server doesn't cap it beyond the DO's normal limits.

### 3.4 Visible and hidden channels (prefetch)

- A **hidden** channel is synced and kept live (so switching to it shows the latest text at once) but **doesn't count as presence**. Its client sends no awareness for it. It still gets `blame`, `status` and updates.
- `view {hidden:false}` makes it visible. The client then sends its awareness, and presence shows the user in that note. `view {hidden:true}` sets it back. The client also clears its awareness state there (a y-protocols `null` state).
- **Presence for a note** = the users with a visible channel on it, plus agents with a cursor there (room-owned awareness). In `Room.participants()`, connections flagged `hidden` are skipped unless they have an awareness state.
- **Cost of a prefetch:** a cold room open (one store head plus a file read and blame, which v1 already pays on the switch itself) and a room in DO memory. Clients prefetch on intent (hover in the tree, the previous note), at most 2 at a time. Prefetched rooms make no commits (no edits).

### 3.5 Read-only

`readOnly` (welcome) is the workspace level. A channel is read-only if the workspace is read-only or the open asked for it. Read-only channels are as in v1: their sync updates are ignored, they get `blame`, and they can send awareness.

### 3.6 Heartbeat and awareness renewal (fewer DO wakes)

CF-30 measured an idle tab waking its WorkspaceDO every 15 s, because y-protocols renews awareness every 15 s and drops remote states not renewed in 30 s. With a long-lived socket, the server knows when a client is gone (the socket closes), so renewal no longer needs to be frequent:

- **Liveness heartbeat (0 DO wakes):** the client sends the text frame `"ping"` every `pingMs` (30 s) while the socket is open. On Workers, `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))` answers it **without waking the object**. On Bun the message handler answers it.
  - The client reconnects when a `pong` doesn't come within 10 s, and at once on `online` and on `visibilitychange` to visible after a network change.
  - The heartbeat also keeps intermediaries (Cloudflare's ~100 s idle limit) from cutting an idle socket.
- **Dead sockets, server side:**
  - Workers: on every wake (any frame or alarm), `ctx.getWebSocketAutoResponseTimestamp(ws)` older than `2.5 × pingMs` (75 s) closes that socket. Its channels leave their rooms, which removes their awareness and presence.
  - Bun: the `websocket.idleTimeout` is set to 75 s; the pings count as traffic.
- **Awareness renewal:** a client renews its awareness state on a visible channel only when it sent no awareness update there for `renewMs` (**5 min**, was 15 s). Cursor moves and typing already renew it. Hidden channels send none.
- **Awareness timeout** (server sweep and clients' removal of remote states): **12 min** (`awarenessTimeoutMs`, 2.4 × renewal) for states owned by a v2 channel. It is only a backstop for a frozen tab whose socket stays up. Sockets that go away remove their states at once (above).
  - Agent cursors (room-owned, no connection) keep their 30 s timeout.
  - States owned by v1 connections keep 30 s.
  - `Room.sweepAwareness` picks the timeout by owner.
- **The safety alarm when idle** (CF-42): today it runs every 60 s while any socket is open, and does a fresh store head read each time. With v2 it runs every 60 s only while a room is in memory and dirty, a crash log needs recovery, or an import is due. While the DO only holds idle hibernated sockets, it runs every **10 min** (the missed-webhook poll fallback, plus the dead-socket check). The alarm no longer reattaches every socket and wakes every room. It only wakes rooms with work to do (dirty, or a crash log with no channel).

## 4. Workspace events on the socket

The socket replaced the tab's `/api/events` SSE stream (now removed). Events go out on channel 0 to every socket of the workspace. They come from the WorkspaceDO (or, on Bun, the workspace's runtime) itself, not from HubDO:

| Message | When | Replaces SSE |
| --- | --- | --- |
| `{t:"presence", files:[{path, users:[{id,name,color,kind}]}]}` | Right after `welcome`: the snapshot of every note with someone in it | the stream's presence snapshot |
| `{t:"presence", path, users}` | When a note's presence changes (`users: []` = nobody) | `presence` |
| `{t:"tree", head}` | When the file list or the head changes (create, delete, rename, outside push, commit of a new file). The client refetches `GET /api/workspace/:id/tree` with `If-None-Match` (often a 304), or skips it when `head` and its pending set say nothing changed | `tree` |
| `{t:"saved", path, sha}` | When a note is committed (the history panel refreshes) | `saved` |
| `{t:"workspace", status, error?}` | When the import status changes (`importing` → `ready` / `error`) or the title changes | the part of `repos` that concerns this workspace |

- When the workspace is removed, its sockets get `{t:"workspace", status:"removed"}` and then a socket close `4404`.
- **Not on the socket:** the global `repos` event (another workspace was created, removed or renamed). Socket clients refetch `GET /api/workspaces` (cheap: `repos.head`, no store calls) when the switcher opens and after a reconnect, instead of keeping a global stream open.
- **The presence snapshot needs no room wakes.** It is computed from the socket channel table: every socket's visible channels give (path, user). On Workers that table is rebuilt from attachments after a wake (§5). Agent cursors are added from rooms in memory. Agent presence doesn't survive hibernation (agents keep a cursor for 30 s anyway).
- **`/api/events` is gone** (2026-10-30), with HubDO and the WorkspaceDO's hub forwarding: channel 0 is the only event channel. A v1-only client gets no live tree or presence (its notes still sync).
- **Events that start in a Worker request** (`repos.ts`: create, link, remove) reach the sockets through the DO. Removal already calls the DO's `remove()` RPC, which closes the sockets. CF-41 audits `emit` calls for others that need a DO hop.

## 5. Hibernation

### 5.1 The attachment (≤ 2 KiB; the JSON is kept ≤ 1800 bytes as today)

```ts
interface SocketAttachment {
  v: 2;
  u: Participant;            // who (from the admission); shared by all channels
  b: string;                 // branch
  ro: boolean;               // workspace read-only
  n: number;                 // next channel id (never reused)
  c: Array<[ch: number, path: string, generation: string, flags: number]>;  // open channels; flags: 1 = read-only, 2 = hidden
  aw: Array<[ch: number, clientId: number, clock: number, state: string]>; // awareness states, visible channels only
}
```

Typical size: user ~250 B, 8 channels × ~75 B (40-character path + 21-character generation) ≈ 600 B, and 1–2 awareness states ≈ 200–400 B, so ~1.2 KB. The attachment is rewritten (`serializeAttachment`, in memory, no I/O) on open, close and view, and on an awareness update of one of the socket's channels, as today.

**When it doesn't fit**, `fit()` cuts in this order until the JSON is ≤ 1800 bytes:

1. Awareness states of hidden channels (there should be none).
2. Awareness states of visible channels, oldest first. After a wake that cursor reappears on its next move or renewal.
3. The avatar.
4. Long names and emails (100 / 200 characters).
5. **Long paths:** a path over 64 bytes is stored as `"#" + sha256(path)[:16 hex]`, and the full path goes in DO SQLite table `channel_paths(hash TEXT PRIMARY KEY, path TEXT)` with `INSERT OR IGNORE`. That is one local write per distinct long path, not per socket. The alarm deletes rows that no attachment references. This keeps 8 channels of 431-character paths (CF-30's test path) under the cap.

The channel table is never truncated: a channel that is open is always in the attachment. If even step 5 can't fit (in practice impossible with 8 channels), the open fails with `error 4429`.

### 5.2 Wake: reattaching every channel with 0 store calls

The first message on a socket the DO doesn't have in memory (after hibernation):

1. **Rebuild the socket table:** for every `ctx.getWebSockets()`, read its attachment and recreate its multiplexer state (user, channels, flags, awareness). This builds a `path → [(socket, channel)]` index. It is only in-memory deserialization: no SQLite, no store, no D1, no fetch. **Rooms aren't woken here.** Tags aren't needed (v1's `p:<hash>` tag can't name channels opened after accept). v2 sockets get the single tag `"w2"`, so v1 and v2 sockets are easy to tell apart.
2. **Deliver the frame to its channel.** If the room isn't in memory, `RoomManager.wake(repo, path, branch)` rebuilds it from the crash log (synchronous, DO SQLite only). Then `Room.reattach(conn, aw)` puts back **every channel on that path** from the index (all sockets), with their awareness states, silently. Then the frame is applied, and `ensureBlame()` runs only after it, as today.
3. **No crash log, or another generation:** only the channels on that path get `{t:"end", code:1013}`. The socket and its other channels carry on (v1 closed the whole socket). The client reopens with its `sv`.
4. **Frames on other channels** wake their rooms the same way, lazily: a wake costs one crash-log replay per note that is actually used, not per open channel.
5. **Awareness-only frames for a room not in memory** (an idle renewal) should, as an optimisation in CF-42, be relayed without waking the room. Apply the ownership rule from the attachment, update that socket's attachment, and forward the frame to the other channels of that path from the index. The room picks the state up from the attachments when it wakes. Without this, a renewal costs one crash-log replay (usually one or two rows).

This keeps CF-24/CF-30's guarantee: **the first frame after a wake makes 0 Git-store calls and 0 fetches** (no D1, no Code Storage), now for every channel.

Room lifetime is unchanged:

- A room with at least one channel (visible or hidden) is never closed by `closeIfIdle`.
- Closing the last channel on a note lets the alarm commit and close it.
- Every open room has `room_meta` from its open (`saveMeta`), so it can always be woken.

**The demo** keeps standard (non-hibernatable) sockets. Same multiplexer, no attachments needed. Its reset ends every channel with `end 1013 "reset"` and keeps the sockets open: clients reopen and get the new generation.

### 5.3 Bun

No hibernation. The multiplexer state lives in memory in the workspace's `WorkspaceRuntime`, which keeps a set of its v2 sockets for events and presence. Everything else is the same code:

- the channel table and limits;
- open, close and view;
- `end` on room close and reset;
- presence from the channel table;
- the per-owner awareness timeouts;
- the heartbeat reply.

Rooms keep their 60 s close timer and 3 s sweep timer. On SIGTERM, `flushAll()` commits, then sockets are closed `1012` (service restart), and clients reconnect as below.

## 6. Reconnect

The socket closes (network, deploy, eviction, 1013 too slow, missing pong). Then:

1. The client reconnects with backoff (500 ms doubling to 10 s, at once on `online`, reset on `welcome`), as `RustCollab` does today.
2. After `welcome`, it **re-opens every channel it had**, all at once (without waiting for each reply), each with its document's `sv` and its `hidden` flag.
3. For each channel the server sends `opened`, `hello`, and step 2 (what the client lacks) plus step 1 (the server's state vector). The client answers step 1 with step 2, which carries **every edit it made while disconnected**. **No edits are lost:** the same exchange as a v1 reconnect, per channel.
4. **Generation:** if `hello.generation` differs from the one the client synced with, the room was recreated. The v1 rule applies: throw the document away, make a fresh one, remount (merging would duplicate text). Unsent edits go through the existing recovery path (`recover.ts`), as today.
5. Channel ids are **new** after a reconnect. The client maps by path from `opened`.
6. Opens that fail on reconnect (`error 4404`: deleted while away) are handled like v1's close codes for that note.

## 7. Migration

1. **Feature detection:** `GET /api/server` (no auth, CORS `*`; the Mac app already calls it) gains `ws: [1, 2]` (the protocol versions served). `welcome.v` confirms it on the socket. A client that doesn't see `2` uses v1.
2. **Both endpoints run side by side.** `/ws?repo&path` (v1) keeps working, unchanged, until the Mac app ships the v2 client. It shares rooms with v2: one room, whose connections are a mix of v1 sockets and v2 channels. On Workers, v1 sockets keep their `p:<hash>` tag and v1 attachment, and the wake path handles both (a socket's attachment `v` says which).
3. **Mixed rooms and renewal:** v1 clients drop remote states not renewed in 30 s. While a room has at least one v1 connection, the server sends `{t:"renew", ms:15000}` to its v2 channels. When the last v1 connection leaves it sends `{t:"renew", ms: renewMs}`. So a v1 Mac user never loses a v2 user's cursor, and the cost stays where the old client is.
4. **Web client** (CF-43) ships with the server, so it switches to v2 the moment the server supports it. It drops `/api/events` once it is on the socket.
5. **Mac app** (CF-44, laptop repo, synced into `native/`) moves to v2 behind the `/api/server` check, so it still works against older self-hosted servers.
6. **Removal** (CF-45): after both clients have shipped (the Mac app released, and the v1 connection count on staging and production at ~0 for a week), remove `/ws?…&path=`:
   - the v1 admission and attachment;
   - the `p:` tags;
   - the 30 s v1 timeouts and `renew` 15 s;
   - `ws: [2]` in `/api/server`.

   A v1 request then gets an upgrade-then-close `4426` ("upgrade the app").

## 8. Agents, MCP and the shell

Agents (share links), MCP and `/api/shell` are HTTP and **unaffected**. Their edits reach rooms through `agentEdit`, and their cursors are room-owned awareness, which v2 channels receive like any awareness update. `watch` and `waitForChange` are unchanged.

## 9. Efficiency estimates

Per tab, Workers. "Today" is from the code, CF-24 and CF-30.

| | Today (v1) | v2 |
| --- | --- | --- |
| **Connections per note switch** | 1 new WebSocket (TCP + TLS + upgrade on HTTP/1.1) | **0** (one `open` frame; 0 frames for a prefetched note, just `view`) |
| Round trips from click to text | ~3–4 (TCP, TLS, upgrade, sync) | **1** (`open` → `opened` + step 2); **0** if prefetched |
| Worker invocations per switch | 1 (admission) + 1 DO fetch | **0** + 1 DO message |
| **D1 queries per switch** | 0–4: session lookup on an auth-cache miss, workspace row on a repo-cache miss, `recordJoin` read/insert on an LRU miss (per isolate) | **0** (all of it once per socket) |
| **DO wakes per idle hour** (one idle tab, visible note) | ~300: 240 awareness renewals (every 15 s) + 60 safety alarms, each alarm with a Code Storage head fetch (CF-30) | **~18**: 12 renewals (5 min) + 6 alarms (10 min), with 6 head fetches. The 120 pings are auto-responses (0 wakes). With the §5.2 relay, renewals don't replay the crash log. |
| DO wakes per idle hour, N idle tabs on one workspace | ~240 N + 60 | ~12 N + 6 |
| Long-lived connections per tab | 1 per open note + 1 SSE to the global HubDO | **1** (no SSE; the hub stops fanning every workspace's events to this tab) |
| Server work per event | HubDO writes the event to every SSE stream of every workspace | the WorkspaceDO sends it to its own sockets only |

Reconnect after a deploy: today one socket per open note, plus the SSE. v2: one socket, plus one `open` per channel in the same flight.

## Implementation shape

One shared multiplexer so Bun and Workers can't drift:

- **`src/shared/wsmux.ts`** (landed with the interface): the framing (`decodeFrame`, `withChannel`, `encodeControl`, `decodeControl`), the message types, the policy constants and codes, the parsers, and the client's shape (`WorkspaceClient`, `WorkspaceChannel`). No Bun, Node or Worker APIs: the server, the DO and the browser import it. The server-side interface (`MuxHost`, `WorkspaceSocket`, `MuxState`, `ChannelConn`, `WorkspaceSockets`) is declared in `src/server/wsmux.ts`.

- **`src/server/wsmux.ts`** (new, CF-41): `WorkspaceSocket` (one per socket) does everything in §2–§4:
  - the framing (channel prefix in and out);
  - channel-0 control: open, close, view and limits;
  - one `Conn` per channel: its `send` adds the prefix, and its `close(code, reason)` becomes `end` instead of closing the socket. `Room` stays unaware of channels.
  - the presence table and events.

  It uses host hooks:
  - `openRoom(path)` (the `admitFile` logic);
  - `send(bytes)` and `closeSocket(code)`;
  - `persist(state)` (no-op on Bun; `serializeAttachment` + `fit` in the DO);
  - `restore(state)` (the DO after a wake).
- **`room.ts`** (CF-41): `Conn.hidden` respected by `participants()`; a per-owner awareness timeout (`Conn.awarenessTimeoutMs`); `renew` sent when the v1 mix changes; `addConn(conn, sv?)` sends step 2 for `sv` right after `hello`/`blame`.
- **`rooms.ts`** (CF-41): `discardRepo` ends channels with `end 1013 "reset"` (through `conn.close`).
- **`app.ts`** (CF-41): `admitWorkspace` without the path, and not-ready workspaces admitted for v2; `Upgrader.workspace`; `/api/server` `ws: [1, 2]`.
- **`workspace.ts`** (CF-41): the runtime holds its v2 sockets and the event fan-out to them (Bun); the event/presence logic shared with the DO.
- **`src/server/index.ts`** (CF-41): the Bun `websocket` handlers for v2 (`idleTimeout` 75 s, `"ping"`).
- **`src/workers/workspace-do.ts`, `router.ts`** (CF-42):
  - the v2 admission header and forwarding;
  - `acceptWebSocket(ws, ["w2"])`, the attachment and `fit`, and `channel_paths`;
  - wake = rebuild the table, lazy room wake per channel, per-channel `end 1013`;
  - `setWebSocketAutoResponse`, the dead-socket check and the idle alarm cadence;
  - events to the DO's own sockets (the HubDO forwarding is gone).
