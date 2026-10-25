# Architecture — Shared Notepad for Agents (Lock-Based)

*Supersedes the Yjs/CRDT design (see `01-research.md`, kept for reference). The product is a shared notepad/workspace for **agents**, not simultaneous human editing. User decision: a straightforward lock with reader exclusion, not nonblocking snapshot reads.*

## 1. Requirements & chosen semantics

- Agents may **read in parallel without requesting a write lock**.
- To modify the document, an agent must **explicitly acquire an exclusive write lock**; the holder may also read while holding it.
- **While the write lock is held, there are no other readers.**
- Writers must not starve: **writer-preference queueing** — once a writer queues, the server stops admitting new readers, drains in-flight reads, then grants the writer.

No merging, no CRDT, no OT. Yjs, the y-websocket server, awareness/cursor channel, and the CodeMirror collab binding are all dropped.

## 2. The key simplification that makes reader exclusion cheap

"Reader" here means a **server-side read operation**, not an agent's whole read→think cycle. A read is one bounded RPC: the server copies the current document and returns it in milliseconds. An agent's thinking happens *after* the RPC completes, holding nothing.

So the exclusion rule is enforced by a small **read-write gate** in the server per document:

- `read()`: admitted immediately when no writer holds or is queued; otherwise waits.
- `acquire()`: queued FIFO; once queued, the gate closes to new readers; when in-flight reads drain (count reaches 0) and any current holder releases/expires, the writer is granted.

Because in-flight reads are bounded milliseconds, "drain" is fast. Because the gate closes to new readers the moment a writer queues, writers can't starve (the writer-starvation concern). This is a classic writer-preferring RW lock; it's simple *because* reads are short server-side operations rather than long-lived client-held leases.

**Honest tradeoff (accepted by the user):** while a writer holds the lock — potentially several seconds if it generates text before committing — readers block (up to their bounded wait, then get a retryable `423 Locked`). Mitigations: TTL caps on holds, agents encouraged to keep holds short, blocked reads return quickly with a retry hint rather than hanging forever.

**What reader exclusion does NOT fix** (and why we still need two guards): an agent that reads v1, thinks, then acquires the lock may find the doc at v2. Excluding readers during the write can't prevent that stale-context write. Therefore, even under the lock: every write carries a **fencing `epoch`** and an **`expectedVersion`** CAS guard (§4). This is cheap insurance, not a design change.

## 3. Components

```
 Agents (HTTP/JSON or MCP tools)          Optional observer web UI
        │                                          │ (SSE)
        ▼                                          ▼
┌──────────────────────────────────────────────────────────┐
│ Server (Node/TS)                                         │
│  per document: RW gate (reader count, writer FIFO queue) │
│  lock state: { holder, epoch, expiresAt }  (in memory)   │
│  store: documents + revisions            (SQLite, WAL)   │
└──────────────────────────────────────────────────────────┘
```

- **RW gate + lock manager** (in-memory, per document ID): reader count; writer FIFO queue; current holder `{agentId, epoch, expiresAt}`. Server is single-writer per document by construction; a per-document mutex/queue serializes all gate transitions.
- **Persistence (SQLite):**
  ```sql
  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 0,     -- committed version, +1 per write
    content TEXT NOT NULL DEFAULT '',
    lock_epoch INTEGER NOT NULL DEFAULT 0,  -- fencing token, +1 per acquire
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE revisions (                  -- exact history/rollback, free with plain text
    doc_id TEXT, version INTEGER, content TEXT,
    author TEXT, created_at INTEGER,
    PRIMARY KEY (doc_id, version)
  );
  ```
  On restart, all locks are simply absent (leases are in-memory only; a crashed server releases everything — see §5).
- **Lock scope: whole document**, keyed by string document ID — the same gate serves multiple notepads/sections by using different IDs, with zero extra machinery. Section-level locks inside one freeform doc are rejected (brittle text boundaries).

## 4. Agent-facing API (v1)

```ts
// Reads: no lock requested. Admitted immediately unless a writer holds/queues.
// GET /docs/:id?waitMs=10000
read(docId, { waitMs? }):
  | { ok: true; version: number; content: string; lock: { locked: boolean; holder?: string } }
  | { ok: false; error: 'LOCKED'; retryAfterMs: number }   // 423, waited waitMs, still blocked

// POST /docs/:id/lock   { agentId, ttlMs?, waitMs? }
acquire(docId, { agentId, ttlMs = 15000 /* max 60000 */, waitMs = 30000 }):
  | { acquired: true; epoch: number; expiresAt: number; version: number; content: string }
    // note: returns current snapshot inside the lock — acquire-then-read in one RTT
  | { acquired: false; retryAfterMs: number; version: number }  // queue wait exceeded

// POST /docs/:id/lock/renew   { epoch, ttlMs }
renew(docId, { epoch, ttlMs }): { expiresAt: number }        // 409 if epoch stale

// PUT /docs/:id   { epoch, expectedVersion, mutation, release? = true }
write(docId, {
  epoch,                                  // fencing token — 409 LOCK_LOST if stale/expired
  expectedVersion,                        // CAS guard — 409 VERSION_MISMATCH if != current
  mutation: { type: 'replace'; content: string }
            | { type: 'patch'; oldText: string; newText: string },  // token-saving edits
  release = true,                         // commit + release in one call (keeps holds short)
}): { version: number }

// DELETE /docs/:id/lock   { epoch }
release(docId, { epoch }): { released: boolean }

// GET /docs/:id/events   (SSE; observer UI + agents that prefer push over polling)
//   events: updated {version, author} | lock_changed {locked, holder, expiresAt}
```

Behavioral rules:
1. **Read admission:** if no writer holds the lock and the writer queue is empty → admit (reader count +1, decremented when the response is sent). Else the read waits up to `waitMs`; on timeout → `423` with `retryAfterMs` (the server estimates from the current lock's expiry).
2. **Writer grant:** writers FIFO. On grant: `lock_epoch` incremented (persisted), `expiresAt = now + ttlMs`.
3. **Every `write`/`renew`/`release` checks `epoch === current lock_epoch` AND (for write) `expectedVersion === current version`**; both checks and the mutation happen in one atomic server-side step.
4. **Expiry:** when `now > expiresAt`, the lock is void (checked lazily on any gate transition, plus a timer to wake the queue). Uncommitted state doesn't exist — each `write` commits atomically — so expiry is just "lock disappears"; nothing to roll back.
5. **Crash of a holding agent** = lease expiry. No orphan detection protocol needed; TTL bounds the worst case.
6. **Crash of the server** = all locks gone, document content intact in SQLite (each committed write is a durable transaction; restart loads latest committed version, never a partial write).

## 5. Failure modes & protections

| Failure | Protection |
|---|---|
| Agent crashes holding the lock | TTL expiry (default 15 s, max 60 s); queue wakes, next writer gets `epoch+1` |
| Slow agent loses lease mid-think, wakes and writes (zombie) | Fencing: write carries old `epoch` → `409 LOCK_LOST` |
| Agent read v1, doc now v2, agent writes stale edit | CAS: `expectedVersion` mismatch → `409 VERSION_MISMATCH`, no release, agent re-reads and retries |
| Writer starvation under read flood | Writer preference: gate closes to new readers as soon as a writer queues; in-flight reads are ms-bounded and drain |
| Reader pile-up during a long write hold | Bounded `waitMs` + fast `423` retry; TTL caps hold length; SSE `lock_changed` lets waiters react |
| Partial write visible to readers | Impossible: a write is one atomic commit, and readers are excluded while the lock is held |

## 6. What changed from the Yjs design

Deleted: Yjs/`Y.Doc`, y-websocket sync server, awareness/cursor channel, CodeMirror collab binding, `CollabSession` seam, Alternative B (insert-after-ID), convergence fuzzing. Replaced by: stateless HTTP/JSON RPC (also exposable as MCP tools), SQLite store, the RW gate/lock manager, SSE for push. Honestly lost: parallel simultaneous edits (agents now serialize writes), live human co-typing (a human viewer is read-only or must take the lock like an agent) — acceptable for an agent workspace. Gained: much smaller stack, exact plain-text revision history, and semantics simple enough to hold in your head.

## 7. Non-goals (v1)

No merging/concurrent writing, no offline anything, no auth (unguessable room IDs at best — auth is a pre-public-deployment requirement), no rich text, no cursors/presence.
