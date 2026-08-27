# Verifiable History

> **Status:** Open (2026-08-27). Companion to
> [`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md)
> and [`authorization-sync.md`](./authorization-sync.md).
>
> Product goal: the History page is a list of **verifiable changes** —
> who changed what, when, with cryptographic proof. Loro is the *what*;
> the signed commit envelope is the *who / when / proof*.

## Goal

Each row in History should be checkable:

| Shown | Source | Proof |
| --- | --- | --- |
| **What** | Loro checkout / diff against the previous version | The oplog is the document |
| **When** | Envelope `createdAt` (not the Loro peer timestamp) | Inside the signed JSON |
| **Who** | Envelope `signer` | Ed25519 over that JSON |
| **Proof** | Envelope `signature`, verifiable from the agent's public key | Same bytes `/commit` accepted |

Today History is only the first column. `VersionTitle` renders Loro's
timestamp and `peer {id}…` — a random CRDT peer, not an Agent. The old
“Show Commit” button navigated to `lastCommit`, which 404s for content
edits because those envelopes are discarded after apply.

Genesis is already verifiable (inline certificate). Later edits are not.

## Split of responsibilities

```text
Loro oplog          = mergeable document history (what)
Signed envelope     = certificate for one write (who, when, proof)
History UI          = join the two, per version
Graph / /commits    = not a history store
```

Do not put signatures into Loro change messages. Those strings are
plaintext (`c-…` bucketing tokens, sometimes an agent DID at genesis).
Anyone can write any message. Strict “who” needs the **already-signed
JSON-AD**, including `loroUpdate`.

Do not restore commits as an indexed class. `/commits`, `CommitDetail`
fetch, and a Git-style `previousCommit` chain are the event-sourcing
personality this slice removed.

## Where the code is

Apply still verifies the envelope, imports `loroUpdate`, then:

- **Kept as graph resources:** genesis / rights / parent / destroy
  (`AuthImpact::is_critical()`).
- **Discarded:** ordinary content envelopes.
- **Stamped on the resource:** `lastCommit` = `did:ad:commit:{sig}`
  (echo-dedup, genesis detection). It is not fetchable.

`getLoroHistory()` buckets oplog changes, checkouts each frontier, and
materializes propvals. `useVersions` is local and instant — no network.

## Join: Loro version ↔ envelope

The join key already exists: after apply, `lastCommit` is written into
the resource (and therefore into that version's materialized propvals).

```text
History version  →  propvals.lastCommit  →  envelope blob  →  verify
                 →  Loro checkout        →  diff / snapshot
```

1. Keep the signed JSON in a **side table** keyed by
   `did:ad:commit:{sig}` (same POST body). Not `Tree::Resources`, not
   atoms, not `/commits`.
2. History, for each Loro version, reads `lastCommit` from that
   checkout. If a blob exists, show agent + `createdAt` + a verified
   badge (client re-runs Ed25519 over the canonical JSON). If not,
   show the version as **unattributed** (Loro-only: concurrent peer
   sync without envelopes, legacy snapshots, local-only until drain).
3. Diff / restore stay Loro checkouts. Proof is a property of the row,
   not a separate commit page.

The envelope's `loroUpdate` should match the ops that produced that
version. Server-stamped `lastCommit` is a *following* Loro change on
the same doc; History already drops lastCommit from the content
signature used to dedupe buckets. The join is “this version's
checkout carries this stamp,” not “the Loro change message is the
signature.”

## Persist: always the blob, never the class

For History to be verifiable **by default**, the blob log is not an
opt-in for regulated servers only. Default:

- Persist envelope bytes beside the resource (same `Db` as the Loro
  snapshot — server redb **and** browser OPFS — so offline History
  still verifies local writes).
- Do not index them. Do not list them as a class. Do not fetch them
  from `CommitDetail` or folder columns.

Prune / WORM / “drop blobs on this node” is ops policy on that table,
not graph schema. Authorization-critical rows stay in the graph
(must-retain floor). Content proof lives in the blob table.

A node that deletes blobs still has working documents and Loro
history; History rows become unattributed instead of 404ing a commit
resource.

## Storage and sync

**Where.** A new KV tree on the same `Db` as the document, next to
`Tree::LoroSnapshots` — not `Tree::Resources`, not `Tree::Blobs` (those
are file bytes keyed by BLAKE3). Key = `did:ad:commit:{sig}`. Value =
the signed JSON-AD POST body. Server: redb. Browser: the same tree in
the per-agent OPFS database, so a local write is verifiable on History
before any network.

They are not graph resources. They do not appear in `/commits`, search,
or collections.

**Would they sync?** Two different paths:

| Path | Today | With envelope blobs |
| --- | --- | --- |
| Live write (`COMMIT` / `POST /commit`) | Envelope is the payload. Receiver applies and **drops** content envelopes. | Same payload. Receiver **keeps** the blob at apply. Proof rides the write; no extra protocol. |
| Bulk catch-up (`SYNC_PUSH`) | Loro snapshots only. No envelopes. A newly paired device gets *what*, not signed *who*. | Snapshots still converge the document. Envelopes must be sent too, or History on that device is **Unattributed**. |

So: they sync on the live path by not throwing the COMMIT body away. They
do **not** sync on pairing/catch-up unless Layer 2 carries them (trailer
on `SYNC_PUSH`, or a follow-up fetch of missing `lastCommit` ids). That
is the same gap [`authorization-sync.md`](./authorization-sync.md) already
calls Layer 2 unsigned.

Critical commits already kept in `Tree::Resources` have the same hole:
drive snapshot sync does not walk `did:ad:commit:…` subjects. Proof has
always travelled as the write, not as a class listing.

Cost: each blob repeats `loroUpdate` already in the snapshot. That
duplication *is* the proof. Pruning blobs shrinks disk; History becomes
unattributed; the document still loads.

## History row (target UI)

Replace `Edited {loroTime} by peer {hex}…` with:

- **Verified** — `{agent name} · {createdAt}` after signature check
- **Unattributed** — Loro time only, no agent (no blob / verify fail)
- Diff of *what* (already built)
- Restore (already built)

No navigation to `did:ad:commit:…` as a document. The proof is on the
row.

## What not to do

- Treat Loro `peer` / change `message` as “who.”
- Re-create `/commits` or `CommitDetail` fetch for dates.
- Block current envelope simplification on this join — History is
  Loro-only until the blob table exists; that is an honest gap, not a
  404.
- Require a linear `previousCommit` chain. Concurrent edits merge in
  Loro; two verified envelopes on concurrent changes is correct.

## Open questions

1. **Match quality.** Is `lastCommit` on the checkout a reliable join
   under concurrent writers (two envelopes, one LWW snapshot)? May
   need the client to put `did:ad:commit:{sig}` in the change message
   *after* sign — the delta is signed as `loroUpdate`, so the message
   has to be part of those bytes (sign-after-export already is).
2. **SYNC_PUSH.** Importing a Loro snapshot without the envelopes
   yields unattributed history. Audit nodes should refuse snapshot-only
   catch-up (Layer 2 in [`authorization-sync.md`](./authorization-sync.md)).
3. **Blob size.** Full JSON-AD includes `loroUpdate`. That is the proof
   of *what*. A header-only blob (signer, createdAt, signature, hash)
   proves who/when but not the mutation unless the hash covers the
   oplog change. Prefer storing the full signed body.
4. **Verify in WASM.** Same `validate_signature` path the apply code
   uses; History should fail closed (Unattributed) on mismatch, not
   show a forged signer.
