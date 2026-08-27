# Commits as envelopes — cleanup and cost

> **Status:** Direction decided (2026-08-27). Companion to
> [`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md)
> (what a commit *is*) and [`unified-sync.md`](./unified-sync.md) (one ingest).
> This doc is the *delete list* and the honest speed/size answer.

Keep the signed write. Stop treating a Commit as a queryable event-sourced
resource. Loro is the document; the sync protocol is the transport; a commit is
a small signed receipt the transport is not allowed to omit.

## Would Atomic be faster and lighter?

**Lighter: yes, and that is the main win.** Default `full` retention stores
every signed envelope as a `Tree::Resources` row *with its `loroUpdate` blob
still inside* (`db.rs` `add_resource_tx` special-cases commit DIDs). Live
resource state already lives in `Tree::LoroSnapshots`. So history is a second
copy of every edit, often a **full snapshot** on the Rust `sign_at` path
(`commit.rs` still calls `doc.export_snapshot()` when `set`/`remove` fire —
the TS client already exports deltas).

Worse: `apply_commit` then indexes every commit atom, and
`Value::to_reference_index_strings` falls through to `Display` for
`LoroDoc`, which **base64-encodes the entire blob into both KV indexes**.
Search already skips `did:ad:commit:` (`server/src/search.rs`); the
prop-val indexes do not. That is O(edits × resource size) keys, not O(live
data).

Boot and write latency already scale with file size
([`disk-storage-and-persistence-optimization.md`](./disk-storage-and-persistence-optimization.md):
~62s open on a 5 GB test store vs ~35 ms fresh). Dropping retained commit
rows (and stopping the index bomb) shrinks the file; that is the latency
win for long-lived nodes.

**Faster writes: modest, not transformative.** A live save still does
Ed25519 verify, Loro import, materialize, rights check, search-index the
*resource*. Those stay. What goes away per write:

| Cost today | After envelopes |
| --- | --- |
| `into_resource` + persist commit row | skip (or `maybe_store_commit`) |
| Index ~isA/signer/subject/createdAt **and** the base64 `loroUpdate` | skip |
| Stamp `lastCommit` *into the resource's Loro doc* | id on the wire / a non-CRDT field |
| Fat `COMMIT_OK` (full server commit JSON) | `[request_id][commit_id]` |
| Sequential outbox drain (1 RTT / dirty subject) | pipeline (`unified-sync.md`) |

Signing itself is ~10 ms and already off the keystroke path
([`sign-at-drain.md`](./sign-at-drain.md)).

**Faster reads of current state: barely.** Subscribers already get one
`UPDATE` + `commit_id`, not a commit replay. `GET` does not fetch commit
rows.

**Faster history: already mostly true.** `server/src/plugins/versioning.rs`
reads the Loro oplog. The leftover cost is UI that still `useResource`s a
`did:ad:commit:` (`CommitDetail` when `createdAt`/`createdBy` are not
passed).

**What does not get faster:** cross-agent authorization, genesis identity,
search of live resources, Loro merge. Adding Layer-2 provenance (signed
envelope on `SYNC_PUSH`) makes catch-up *slightly* heavier for untrusted
peers; same-agent replicas can keep id-only.

## Already landed (do not redo)

Since the May retention write-up:

- [x] Versioning plugin is oplog-based (`versioning.rs` — Phase 3 of the
      retention plan, server side).
- [x] `createdAt` / `createdBy` materialized from genesis cert / oplog
      (`Resource::materialize_genesis_metadata`). Chatroom passes them into
      `CommitDetail` so refresh no longer fetches a commit.
- [x] Inline genesis cert (`genesis-self-verifying.md`) — identity no longer
      needs a refetchable genesis *commit resource*.
- [x] Causality guard splits idempotent replay vs silent LWW
      (`imported_new_ops` in `commit.rs`).
- [x] `previousCommit` is not a production validation gate.
- [x] Sign-at-drain: one signed envelope per subject per drain pass.
- [x] TS `exportLoroDelta` is compact; `lastCommit`/`createdAt` bypass Loro
      on the client.

## Cleanup inventory

Grouped by leverage. None of this deletes signing, `/commit`, or the
`COMMIT` frame until Layer 2 carries provenance
([`unified-sync.md` § State-first wire](./unified-sync.md#state-first-wire-commit-as-provenance-envelope)).

### 1. Stop persisting commits as resources (highest storage ROI)

Gate `add_resource_tx(&commit_response.commit_resource)` + the following
`add_atom_to_index` loop behind `maybe_store_commit`. Default can stay
`full` for one release; test mode `none` (genesis + auth-critical floor
still kept). See retention plan Phase 2.

Immediate independent fix, even under `full`: **do not index `Value::LoroDoc`**.
`to_reference_index_strings` should return `None` for it. That stops the
base64-blob index bomb without changing the wire.

Also drop or hide the default `/commits` class collection
(`collections.rs` special-cases `urls::COMMIT` sort). It is an unbounded
audit dump, not a product surface.

### 2. Stop writing `lastCommit` into the Loro document

Server apply currently `set`s `lastCommit` on `resource_new` after every
commit (`commit.rs`). That is a CRDT op on bookkeeping, which:

- bloats every resource's oplog by one change per save
- is why the causality guard must skip `LAST_COMMIT` / `CREATED_AT`
- is why genesis-change selection had to ignore timestamps
  (`genesis-self-verifying.md`)

Keep `commit_id` on `UPDATE` / `COMMIT_OK`. Store it as a non-CRDT
projection field (or only in the client `_lastCommit` cache, which already
exists). Demote `previousCommit` to optional audit metadata; stop building
the chain in `CommitBuilder.sign`.

### 3. One ingest, thinner wire

Already specified in `unified-sync.md`; listed here so it is not forgotten
as "commit cleanup":

- `SYNC_PUSH` carries the signed envelope (or `lastCommit` + bytes past
  it). `import_sync_push` stops being a second unsigned authority (F1).
- Shrink `COMMIT_OK` to `[request_id][commit_id]`.
- Pipeline outbox `COMMIT` frames; optional later `COMMIT_BATCH`.
- HTTP `/commit` stays as fallback until the engine ingest is the only
  apply path, then it becomes a thin wrapper.

Do **not** delete `COMMIT` in favour of raw `SYNC_PUSH`. That is how F8–F10
happened.

### 4. Dead commit-as-event-source code

| Surface | What to remove / shrink |
| --- | --- |
| `CommitBuilder.set` / `remove` / `push` (Rust + TS) | Server already rejects `set`/`push`/`remove` on the wire. Keep a server-internal conversion at `sign_at` only until `Resource::save` is doc-first; delete from the TS builder and public commit JSON. |
| `browser/lib/src/commit.ts` `set`/`push`/`remove` | Dead on the wire; still in `hasUnsavedChanges` and tests. |
| `materializeCommitLocally` / `did:ad:commit:` fetch | History UI reads oplog; author/time from propvals. |
| `CommitDetail` commit-fetch fallback | Require `createdAt`/`createdBy`; drop `useResource(commitSubject)`. |
| `docs/src/commits/intro.md` | Stop selling event-sourced history. Commits = signed envelopes. |
| Tests that `get_resource(did:ad:commit:…)` | Gate on retention policy. |

`lib/src/commit.rs` (~3k lines, much of it tests) stays — that is verify +
apply. `commit_monitor.rs` stays — that is fan-out of `UPDATE`/`DESTROY`,
misnamed.

### 5. Must-retain floor (do not clean these up)

- Genesis envelope / inline genesis cert (identity).
- Rights / parent / destroy commits while
  [`authorization-sync.md`](./authorization-sync.md) needs grant-chain
  evidence — or a signed auth checkpoint that replaces them.
- The `COMMIT` frame and signature fields: `subject`, `signer`,
  `signature`, `loroUpdate`, `isGenesis`, `destroy`.

## Suggested order

1. **Index skip for `LoroDoc`** — tiny, reversible, measurable index-size
   drop on any existing store after rebuild.
2. **`maybe_store_commit` + `retention=none` test mode** — prove
   read/write/sync/history without commit rows (genesis kept).
3. **`lastCommit` out of Loro** — unblocks cleaner apply and smaller docs.
4. **Layer 2 provenance** — then HTTP `/commit` can shrink.
5. **UI + spec** — no commit fetches; docs match the envelope model.
6. Default retention → `recent`.

## Related

| Doc | Role |
| --- | --- |
| [`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md) | Policy, apply semantics, retention floor. |
| [`unified-sync.md`](./unified-sync.md) | One ingest; F1; fat `COMMIT_OK`; pipelined drain. |
| [`disk-storage-and-persistence-optimization.md`](./disk-storage-and-persistence-optimization.md) | Snapshot-vs-delta + compaction; this doc adds the commit-row / index term. |
| [`genesis-self-verifying.md`](./genesis-self-verifying.md) | Identity without fetching a genesis commit resource. |
| [`authorization-sync.md`](./authorization-sync.md) | Why some envelopes must still be kept. |
