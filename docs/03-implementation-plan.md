# Implementation Plan — Agent Notepad (Lock-Based)

Tracks `02-architecture.md` (RW gate + exclusive leased write lock, writer preference, fencing + CAS). Status: `[ ]` todo, `[~]` in progress, `[x]` done.

---

## Phase 0 — Scaffold (0.5 day)

- [ ] `pnpm` workspace: `server/` (Node + TS), `client/` (agent SDK + minimal observer UI), `shared/` (API types).
- [ ] Tooling: biome, vitest, `dev`/`test`/`build` scripts.
- [ ] No Yjs/CRDT dependencies. SQLite (better-sqlite3 or node:sqlite) + a tiny HTTP layer (or MCP server harness) — decide transport in Phase 1.

**Exit:** empty server answers a health check; CI runs tests.

## Phase 1 — Document store + RW gate + lock manager (2 days, core)

- [ ] SQLite layer: `documents` + `revisions` tables; load on demand, cache hot docs in memory; every committed write = one transaction that bumps `version`, appends `revisions`, updates `content`.
- [ ] Per-document gate state machine (single-threaded transitions):
  - reader count; writer FIFO queue; `{ holder, epoch, expiresAt }`.
  - read admission: admit iff no holder AND empty writer queue; else park up to `waitMs` → `423`.
  - acquire: enqueue; on grant persist `lock_epoch+1`, set expiry; return `{epoch, version, content}`.
  - drain logic: grant writer when reader count hits 0 and no current holder.
  - expiry sweep: timer + lazy check on every transition; wake queue on expiry.
- [ ] Endpoints per API in `02-architecture.md` §4: `read`, `acquire`, `renew`, `write` (epoch + expectedVersion checks, `replace`/`patch` mutations, `release` flag), `release`.
- [ ] Unit tests for the gate: admission rules, writer preference, drain, expiry, stale epoch, stale version.

**Exit:** two scripted agents concurrently read/write one doc via HTTP with correct serialization and correct 409/423 responses.

## Phase 2 — Events + observer UI (1 day)

- [ ] SSE endpoint `/docs/:id/events`: `updated`, `lock_changed`.
- [ ] Minimal web page per doc: live content, version number, lock status/holder, revision list (click to view old version). Read-mostly; editing via UI takes the lock like an agent (optional in v1).

**Exit:** open the page, run two agents, watch content + lock status update live.

## Phase 3 — Agent SDK polish (0.5–1 day)

- [ ] Thin TS client: `read`, `withLock(docId, fn)` helper that acquires (with wait), auto-renews on a timer while `fn` runs, writes with `expectedVersion` from the acquire snapshot, releases; structured errors for `LOCK_LOST` / `VERSION_MISMATCH` / `423`.
- [ ] Document recommended agent pattern: *acquire → use returned snapshot → write → release* (short holds); and the safe *read (no lock) → think → acquire → re-check version → write* pattern.

**Exit:** a 20-line example agent uses the SDK correctly.

## Phase 4 — Hardening: lock-safety chaos tests (1–2 days)

- [ ] **Zombie writer:** A acquires (short TTL) → lease expires → B acquires & writes → A wakes, writes with old epoch → assert `409 LOCK_LOST`, doc uncorrupted.
- [ ] **Stale-read CAS:** A reads v1; B writes v2; A acquires (valid epoch) and writes with `expectedVersion: 1` → assert `409 VERSION_MISMATCH`, lock still held by A.
- [ ] **Reader exclusion:** start a write hold; assert concurrent `read()` calls block until release (no reader observes any state mid-hold).
- [ ] **Writer preference / no starvation:** continuous reader flood + one queued writer → assert writer granted within one read-drain bound; no new readers admitted after writer queued.
- [ ] **Crash storm:** N agents with random crashes/timeouts contend; assert strict serialization, monotonic `version`, no deadlock, all locks eventually clear.
- [ ] Restart test: kill server mid-hold → restart → doc intact at last committed version, locks clear.

**Exit:** full suite green in CI; documented limits (max doc size, TTL bounds, queue cap).

## Phase 5 (optional / later)

- [ ] Auth (agent identity + room access) — required before any public deployment.
- [ ] Multiple named docs per workspace listing/index.
- [ ] MCP tool exposure if agents connect over MCP.
- [ ] `read({waitForUnlock})` long-wait / SSE-based "notify me when unlocked" if polling `423`s gets noisy.

---

## Assumptions

1. Workload is agents: coarse read→think→write cycles, not keystroke streaming; ≤ tens of agents per doc.
2. Reads are short server-side ops; reader exclusion windows are therefore tiny except while a writer holds the lock (accepted tradeoff).
3. Single-server deployment; in-memory lock state is fine because server crash = clean slate for locks, durable data in SQLite.
4. No auth in v1; whole-document lock scope (multiple docs via distinct IDs).

## Open questions

1. Transport: plain HTTP/JSON vs MCP-first (or both)? Affects Phase 1 plumbing only, not semantics.
2. Hold-length norms: should the SDK discourage >N-second holds, or should the server warn/metric long holds?
3. Do agents want structured append (`append` mutation for logs) as a first-class op? Cheap to add under the same guards.
4. Revision retention policy: keep all revisions (notepad scale = fine) or prune?
5. Human edit-in-UI: v1 read-only observer, or lock-taking editor too?

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Long agent holds degrade read latency for others | medium | TTL caps, `release:true` default on write, SDK auto-heartbeat + prompt release, `423` fast retry |
| Agents ignoring `409 VERSION_MISMATCH` and retrying blindly (lost-update loops) | medium | SDK handles reconcile-on-409 explicitly; document the pattern |
| Lock queue pile-up under heavy contention | low–medium | FIFO + queue cap + bounded `waitMs`; split busy workspaces into multiple docs |
| Writer-preference inverts into reader starvation under write flood | low | Bounded holds + FIFO; monitor queue depth; acceptable at v1 scale |
