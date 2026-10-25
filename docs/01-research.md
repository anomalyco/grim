> **SUPERSEDED (2026-10-24):** The product pivoted from simultaneous human editing to a shared workspace for agents. Concurrent-edit merging is no longer required, so the CRDT/OT question below is moot — the current design is a simple leased write lock (see `02-architecture.md`). Kept for reference.

# Research: Collaborative Text Editing — State of the Art

*Compiled 2026-10-24. Scope: plain-text "notepad", online-first, no offline merging required, must handle concurrent edits and ordinary network latency correctly, live cursors.*

---

## 1. The core problem

A shared document is edited by several clients with non-zero network latency. Each client must render local keystrokes immediately (locking the text until a server round-trip is unusable beyond ~100 ms of latency), so concurrent edits are inevitable. The classic failure mode is **index drift**: Bob sends "insert ` the` at index 17", but Alice's concurrent "insert ` gray` at index 3" lands first at the server, so Bob's index-17 insert no longer means what he intended. Every approach to collaborative text is, at heart, a way of making position references stable across concurrent edits.

Three families of solutions matter today:

1. **Operational Transformation (OT)** — 1989+ (Ellis & Gibbs). Positions stay as integer indices; operations are *transformed* (rebased) against concurrent operations. Requires a central authority (or very hairy distributed protocols) to define a total order. Used by Google Docs, MS Office, Overleaf.
2. **CRDTs** — 2005/6+ (WOOT, RGA, Logoot, …). Every character gets an immutable unique ID; IDs are ordered by a mathematical total order, so concurrent ops commute and no transformation is needed. Costs: per-character metadata, tombstones, load-time and memory overhead. Used by Figma-adjacent tools, Notion, Linear, many others via Yjs/Automerge.
3. **Server-authoritative "insert-after-ID"** — a recent, deliberately simple hybrid (Matthew Weidner, 2025): characters get unique IDs (like CRDTs) and clients send "insert X after ID Y", but *no mathematical ordering algorithm* — the server applies operations literally in receive order and clients reconcile via general-purpose server reconciliation. Correct because the server defines the order; much simpler than either classic family.

A fourth, adjacent technique, **fractional indexing** (Figma), orders list items by real-number-ish positions. Evan Wallace explicitly warns it is *inappropriate for text* because concurrent runs of characters interleave; fine for layer stacks, not for a notepad's character sequence. Noted here only to rule it out for the text body.

Sources: [Weidner 2025](https://mattweidner.com/2025/05/21/text-without-crdts.html), [Figma/Wallace 2017](https://www.figma.com/blog/realtime-editing-of-ordered-sequences/), [Wallace, fractional indexing 2022](https://madebyevan.com/algos/crdt-fractional-indexing/).

---

## 2. Approach deep-dives and tradeoffs

### 2.1 Operational Transformation (OT)

- **How:** clients send index-based ops tagged with the server version they were made against. The server (central authority) transforms late-arriving ops against everything that happened since, appends to a linear history, and broadcasts. Clients transform pending local ops across incoming remote ops (and vice versa).
- **Pros:** minimal document metadata (just text + version counter); the document file is plain text; conceptually matches what editors already produce (change sets); proven at Google-Docs scale.
- **Cons:** transform functions must satisfy algebraic properties (TP1/TP2) with quadratically many cases; published OT algorithms have a long history of subtle flaws without formal verification. Offline/long-branch merging is quadratic — the Eg-walker paper shows a trace that takes OT ~1 hour to merge vs 24 ms for their algorithm. That weakness is irrelevant for us (online-first) but worth knowing.
- **Ecosystem:** [ShareDB](https://github.com/share/sharedb) (mature, still maintained — v5.2.2, May 2025; JSON OT database with presence, middleware, persistence adapters; heavier than a notepad needs), [@codemirror/collab](https://codemirror.net/examples/collab/) (tiny OT toolkit built into CodeMirror 6 — central-authority protocol with versioned push/pull and `rebaseUpdates`; the documented reference protocol is ~100 lines), [rushlight](https://github.com/ekzhang/cm-collab) (Eric Zhang's production-ish CodeMirror-OT server on Redis; "boring" by design), [ot.js](https://github.com/Operational-Transformation) (older).
- Note the CodeMirror authority can legitimately *reject* stale pushes; rebasing is preferred to avoid starvation of high-latency clients.

### 2.2 CRDTs

- **How:** each character (or run) gets a unique, immutable position ID; a total order over IDs makes all concurrent ops commute. Deletes leave tombstones.
- **Pros:** no central authority needed (P2P capable); convergence is guaranteed by construction; correctness doesn't depend on a transform function; handles arbitrary offline divergence if that ever becomes in-scope.
- **Cons:** memory and load-time overhead (even the best libraries are >10× OT's steady-state memory per the Eg-walker paper); tombstones accumulate; the ordering algorithms are subtle; libraries are networked black boxes that are hard to customize (sub-document permissions, suggestion-mode, custom op semantics — see Weidner's list).
- **The interleaving problem:** older list CRDTs (RGA, Logoot, fractional indexing) can interleave two concurrently typed passages character-by-character ("corrupted" text). **Fugue/FugueMax** (Weidner & Kleppmann, IEEE TPDS Nov 2025) define "maximal non-interleaving" and fix this; Yjs's YATA already largely avoids it in practice for left-to-right typing.
- **Ecosystem:**
  - **[Yjs](https://docs.yjs.dev/)** — the de facto industry standard for real-time text (powers Notion, Linear, Tiptap). JS, ~26 KB, very fast (see benchmarks: often 10×+ faster than Automerge on text traces). Bindings for CodeMirror, ProseMirror/TipTap, Quill, Monaco, and plain textareas via `y-textarea` demos. Crucially for us: the **Awareness protocol** ([docs](https://docs.yjs.dev/getting-started/adding-awareness), [spec](https://github.com/yjs/y-protocols/blob/master/PROTOCOL.md)) is a separate ephemeral state-based CRDT for exactly our cursor/presence feature — per-client JSON state (cursor, name, color), heartbeat (~15 s broadcast, 30 s expiry), auto-cleanup on disconnect. Editor bindings render remote cursors from awareness directly. Servers: [`@y/websocket-server`](https://github.com/yjs/y-websocket-server) (simple, single-node), [Hocuspocus](https://tiptap.dev/docs/hocuspocus) (full-featured, hooks/auth/persistence), [y-sweet](https://github.com/jamsocket/y-sweet), y-redis (scale-out). Yjs v14 (`@y/y`) is in flight; v13 remains the stable line.
  - **[Automerge](https://automerge.org/)** — local-first sync engine; stores *full immutable history* (Git-like branching/versioning/audit). [Automerge 3.0](https://automerge.org/blog/automerge-3/) (July 2025) cut memory >10× (Moby Dick paste: 700 MB → 1.3 MB), making its sync servers much more viable. Heavier (~931 KB core, WASM), still slower than Yjs for large text; rich-text support via ProseMirror binding is newer. Best when auditability/offline is the point — more than we need.
  - **[diamond-types](https://github.com/josephg/diamond-types) / Eg-walker** — state of the art algorithmically (Gentle & Kleppmann, [EuroSys 2025 paper](https://doi.org/10.1145/3689031.3696076), [paper repo](https://github.com/josephg/egwalker-paper), [TS reference impl](https://github.com/josephg/eg-walker-reference)). Stores the raw operation log (OT-like, tiny memory) and runs a CRDT only transiently to merge concurrency; 1–2 orders of magnitude less memory than CRDTs, merges up to 160,000× faster than OT on divergent traces. **Caveat:** plain-text only, v2 unpublished to npm/crates as of mid-2026; author himself says "use Yjs or Automerge" for object editing. One to watch, not to build on today.
  - Rust ports: yrs (Yjs in Rust, now reportedly *faster* than Yjs), pycrdt for Python.

### 2.3 Server-authoritative insert-after-ID (no OT, no CRDT)

Source: [Matthew Weidner, "Collaborative Text Editing without CRDTs or OT"](https://mattweidner.com/2025/05/21/text-without-crdts.html) (May 2025; idea credited to Wim Cools/Thymer, also used by Jazz's CoLists).

- **How:** state is `Array<{ id: UUID, char?, isDeleted }>` (tombstoned ID list, stored on client *and* server). Client typing sends "insert `char` after `beforeId` with new id `id`". Server applies ops *literally* in receive order — its state is authoritative. Clients apply edits optimistically and use general-purpose **server reconciliation** (on remote op: undo pending local ops → apply remote → redo pending) to stay converged.
- **Why it fits this project unusually well:** online-first is exactly its design point; it needs no ordering algebra, so it's fully understandable and *modifiable by us*; the server can later do flexible things (insert-before, suggestions, permissions, LLM fixups) because algebraic constraints don't bind it.
- **Concurrent same-spot inserts** resolve in reverse server-receive order without interleaving (RGA-like), as long as people type left-to-right. Backwards-typing can interleave in theory; irrelevant in practice.
- **Costs:** we build the sync layer ourselves: ID list structure (Weidner's [Articulated](https://github.com/mweidner037/articulated/) `IdList` — B+tree, bunched IDs, persistent for cheap rollback — exists but is young, demos "very preliminary"), wire protocol, reconciliation, cursor mapping. Presence is *not* included (Yjs awareness has no equivalent here) — we'd roll a trivial throttled ephemeral channel.
- Also notable: Weidner shows the decentralized variant of this scheme *is* RGA/Fugue-like — i.e., "CRDT vs not" is more of a spectrum than a fork ([braid.org draft](https://braid.org/drafts/algorithms/ot-and-crdt) argues similarly).

### 2.4 Comparison summary

| Criterion | OT (central) | CRDT (Yjs/Automerge) | Server-auth insert-after |
|---|---|---|---|
| Correct concurrent edits online | ✅ | ✅ | ✅ |
| Latency tolerance (optimistic UI) | ✅ via client transform | ✅ native | ✅ via server reconciliation |
| Offline merge | ❌ (quadratic/painful) | ✅ native | ❌ (out of scope for us) |
| Doc metadata overhead | minimal (text + version) | high (IDs, tombstones) | medium (ID per char, bunched) |
| Implementation complexity | transform correctness is subtle; small libs exist | none for us (black box) | simple concepts, but we write the sync layer |
| Cursors/presence | DIY | ✅ Awareness protocol built-in | DIY (trivial channel) |
| Server authority / custom semantics | ✅ | awkward | ✅✅ (most flexible) |
| Maturity of ready-made path | ShareDB (heavy), @codemirror/collab (editor-bound) | ✅✅ Yjs ecosystem | Articulated (young) |

**Verdict for this project:** with online-first and no offline merge, CRDT's main advantage is moot; the decision is between the **fastest safe path (Yjs)** and the **most ownable/simple-core path (server-authoritative insert-after)**. Plain OT via `@codemirror/collab` is a respectable middle path but locks the editor choice to CodeMirror and still requires us to write the authority + transport. Recommendation in `02-architecture.md`.

---

## 3. Cursors / presence (independent sub-problem)

Cursor positions must be (a) shared frequently and ephemerally, (b) mapped correctly across concurrent edits. Two parts:

- **Transport:** per-client ephemeral state, last-writer-wins, throttled (~10–20/s), heartbeated, dropped on disconnect. Yjs Awareness gives exactly this ([spec](https://github.com/yjs/y-protocols/blob/master/PROTOCOL.md): 30 s expiry, 15 s rebroadcast, `null` = offline). Note its security caveat: awareness payloads are unauthenticated — identity claims must be enforced above the protocol.
- **Position stability:** an index captured before a remote edit lands points at the wrong character. Fixes: Yjs *relative positions* (bindings do this automatically), OT transform of the index, or ID-referenced positions in the insert-after scheme. Never ship raw indices un-transformed.

---

## 4. Production references (who uses what)

Google Docs / MS Office / Overleaf: central OT. Figma: server-authoritative custom CRDT-ish; fractional indexing for layer order (not text). Notion, Linear: Yjs. Rustpad: OT. Zed: CRDT. Etherpad: OT (changesets). The industry split tracks exactly the tradeoff above: central-authority products lean OT; local-first/P2P products lean CRDT.

---

## 5. Source list

1. Weidner, *Collaborative Text Editing without CRDTs or OT* — https://mattweidner.com/2025/05/21/text-without-crdts.html (2025)
2. Weidner, *Architectures for Central Server Collaboration* — https://mattweidner.com/2024/06/04/server-architectures.html (2024)
3. Gentle & Kleppmann, *Collaborative Text Editing with Eg-walker* (EuroSys 2025) — https://doi.org/10.1145/3689031.3696076 , https://github.com/josephg/egwalker-paper
4. Weidner & Kleppmann, *Fugue: maximal non-interleaving* (IEEE TPDS 36(11), 2025) — https://ieeexplore.ieee.org/document/11181220
5. CodeMirror, *Collaborative Editing example + @codemirror/collab* — https://codemirror.net/examples/collab/
6. Haverbeke, *Collaborative Editing in CodeMirror* — https://marijnhaverbeke.nl/blog/collaborative-editing-cm.html (2020)
7. ShareDB — https://github.com/share/sharedb (v5.2.2, May 2025)
8. rushlight (cm-collab) — https://github.com/ekzhang/cm-collab
9. Yjs docs & Awareness — https://docs.yjs.dev/ , https://docs.yjs.dev/getting-started/adding-awareness
10. y-protocols spec — https://github.com/yjs/y-protocols/blob/master/PROTOCOL.md
11. y-websocket — https://github.com/yjs/y-websocket ; @y/websocket-server — https://github.com/yjs/y-websocket-server ; Hocuspocus — https://tiptap.dev/docs/hocuspocus
12. Automerge 3.0 — https://automerge.org/blog/automerge-3/ (July 2025)
13. HN: Yjs vs Automerge discussion (incl. performance numbers) — https://news.ycombinator.com/item?id=41012895 (2024)
14. diamond-types — https://github.com/josephg/diamond-types ; Eg-walker reference — https://github.com/josephg/eg-walker-reference
15. Wallace/Figma, *Realtime Editing of Ordered Sequences* — https://www.figma.com/blog/realtime-editing-of-ordered-sequences/ (2017); *CRDT: Fractional Indexing* — https://madebyevan.com/algos/crdt-fractional-indexing/ (2022)
16. Articulated (IdList) — https://github.com/mweidner037/articulated/
17. Braid draft, *OT and CRDT* — https://braid.org/drafts/algorithms/ot-and-crdt
18. zallen, *CRDTs are hard* (library field notes) — https://zallen.net/crdts-hard/ (2025)
