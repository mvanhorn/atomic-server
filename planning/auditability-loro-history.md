# Auditability when commits are not persisted

> **Status:** Open question (2026-08-27). Companion to
> [`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md)
> and [`authorization-sync.md`](./authorization-sync.md).
>
> Not a build plan. Captures the gap now that ordinary content commits are
> discarded after apply, and a lightweight way to close it for deployments
> that need a strict audit trail.

## Where the code is

Commits are signed envelopes. Apply still verifies `signer` + `signature`,
imports `loroUpdate`, and materializes the resource. After that:

- **Kept as resources:** genesis, rights (`read` / `write` / `append`),
  parent, destroy — `AuthImpact::is_critical()`.
- **Discarded:** ordinary content envelopes. No `/commits` collection. UI
  does not fetch `did:ad:commit:…`. `previousCommit` is not a causal gate.

`lastCommit` on the resource is a stamp (echo-dedup, genesis detection), not
a refetchable document.

## What Loro history gives

The resource's Loro oplog is the mergeable history. `get_history()` /
`getLoroHistory()` checkout frontiers and show *what the document looked
like* at each change.

Each Loro change carries a random peer id, a timestamp, a Lamport clock, and
an optional string message. That message is **not** a signature. Today:

- Genesis may stamp the agent DID as the change message (legacy fallback for
  `createdBy` when there is no genesis certificate).
- Later saves stamp a bucketing token (`c-…`) so history can split versions.
  The History UI hides that token.

So Loro answers **what changed** and **roughly when**. It does not prove
**who** made a later edit.

## What is still cryptographically checkable

| Question | Proof |
| --- | --- |
| Who created this resource? | Inline genesis certificate (agent signature; DID is that signature). |
| Who may write *now*? | Current ACL + retained grant / parent / destroy commits. |
| Who made *this* content edit, with a signature? | **Gone** after apply. The signed JSON was thrown away. |

Write-time authorization is unchanged: the server still rejects an unsigned
or unauthorized envelope. The gap is **after-the-fact** content audit.

## Why “put signatures in the oplog” is the wrong fix

Loro change messages are plaintext. Stamping the agent DID (or even a
`did:ad:commit:{sig}` id) on every change is an attribution *hint*. A peer
can write any string. Strict audit needs the **already-signed JSON-AD
body** — the same bytes `/commit` accepted — so an auditor can re-verify
Ed25519 over the canonical payload, including `loroUpdate`.

Restoring commits as indexed class instances (`/commits`, `CommitDetail`
GET, `previousCommit` chain) brings back the event-sourcing personality this
slice removed.

## Lightweight close: envelope blob log

Keep the signed envelope bytes. Do not make them a queryable class.

After a successful apply, an audit-opted node writes the POST body to a side
table keyed by `did:ad:commit:{sig}`. Same bytes, including signature. No
atoms, no `/commits` collection, no default UI fetch.

```text
write boundary     = verify envelope, import Loro     (required, already)
resource history   = Loro oplog                       (required, already)
audit retention    = optional envelope blob log       (the only add)
```

Default stays drop. A regulated deployment flips one boolean (node flag, or
later a drive property). Not a `none | recent | full` policy enum.

An auditor who knows a commit id can GET the blob and re-verify. A listing
by subject / time is a secondary index on that table, not a class
collection. History may offer “show envelope” **only** when the blob exists.

Authorization-critical rows stay in the graph (must-retain floor). Content
audit lives beside the graph. Browser OPFS should not retain every envelope
by default — that is a node concern. The in-memory Sync-page commit log is
enough on the client.

## What not to do

- Do not treat Loro oplog messages as an audit trail.
- Do not re-index content commits as Atomic resources.
- Do not retain envelopes in every replica (WASM / phones) because one
  server needs WORM storage.
- Do not block the envelope simplification on this log. Default-drop is
  correct until a deployment asks for audit.

## Open questions

1. Node flag vs drive property vs both (node is the deployment floor).
2. GET-by-id only, or also a subject+time listing for auditors.
3. Whether peer `SYNC_PUSH` of Loro snapshots without the matching envelope
   is acceptable on an audit node (probably not — see
   [`authorization-sync.md`](./authorization-sync.md) Layer 2).
4. Retention / legal-hold of the blob table (WORM, size, prune) is ops
   policy on that table, not graph schema.
