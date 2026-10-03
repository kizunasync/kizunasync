---
title: Status taxonomy
description: Every status vocabulary Kizuna uses, from the maturity labels on a page to the sync phases, attachment states, rejection kinds, and decision-register words.
status: alpha
docType: reference
audience: app-developer
---

# Status taxonomy

Kizuna carries several independent status vocabularies. Some describe how mature a surface is, some describe what a running client is doing right now, and some describe how settled a protocol choice is. They do not translate into each other: a shipped surface can be Alpha, a decided wire encoding can lack production-qualified platform evidence, and a green protocol case promotes no driver.

Each label describes one named surface. A page marked Alpha does not make every package it links Alpha.

## Maturity labels

These three words qualify a surface in prose and in the `status` field of a page's front matter. Every page in the published registry carries `alpha`.

| Label | Definition |
|---|---|
| Alpha | The surface exists and can be evaluated, but behavior, API, migration path, or platform coverage may change. Known gaps are stated where they matter. |
| Beta | The intended API and behavior are substantially stable and covered by the relevant automated tests. Remaining qualification gaps and supported environments are documented explicitly. |
| Production | The surface has a documented compatibility and support policy, migration expectations, and evidence for every environment included in the claim. Protocol, integration, and physical platform evidence are distinguished rather than summarized as one conformance result. |

[Project status](../getting-started/status.md) applies these labels surface by surface and separates what exists in the repository from what has been verified and what has been published.

One further label sits beside these three. A documented feature that does not exist carries an explicit `Status: planned` line, and the detail belongs on [Roadmap](../resources/roadmap.md) rather than on the page that mentions it. `planned` says nothing about maturity: it says the surface is not there.

## Decision register status

The register at [`packages/protocol/decisions/`](../../packages/protocol/decisions) holds 24 records. Each record has one of three statuses.

| Status | Meaning | Current records |
|---|---|---|
| `decided` | The choice is ratified and the bytes may be relied on. | Twenty records |
| `open` | A required choice is missing, and no conformant bytes may be inferred for it. | Four records: `D-dedup-storage-model`, `D-base-hint`, `D-wakeup-channel`, and `D-transport-error-codes` |
| `superseded` | Another record replaced this one. | None |

An `open` record still says what is already safe to rely on. A case that cannot run without the missing bytes carries `blocked_on` on a `file: null` manifest entry.

[Decision registry](./protocol.md#decision-registry) names each record by its identifier and [Protocol decisions](../resources/protocol-decisions.md) reads each one in prose.

## Corpus case status

`packages/protocol/cases/manifest.json` gives every conformance case a status, and both the TypeScript executor and the Rust conformance runner branch on it.

| Status | Meaning | Executed |
|---|---|---|
| `normative` | The case pins required behavior. | Yes |
| `decided` | The case pins behavior a named decision settled. | Yes |
| `proposed` | The case pins a shape that is written down but not ratified. | Yes, when it carries bytes |
| `open-decision` | The case names the decision blocking it and carries no transcript bytes. | No, skipped with the gate named |

No case carries `proposed`. One is `open-decision`, which is why 49 of the 50 manifest entries run. [Conformance inventory](./protocol.md#conformance-inventory) lists the groups and names the one skip.

The JSON Schemas carry a parallel `kizunaStatus` annotation on individual nodes, using `normative`, `decided`, `proposed`, and `open-decision` with the same meanings. It qualifies one field or union, not a whole case.

## Sync phases

`getSyncHealth()` reports one phase for the automatic loop. It derives the phase on every read rather than storing it, because connectivity can change without the tracker being told the new value. The phase sits outside the protocol event union on purpose, because loop state is diagnostics.

| Phase | Condition |
|---|---|
| `offline` | The connectivity port reports no network. This wins over every other condition, so an attempt already in flight when the network drops reports `offline` regardless. |
| `syncing` | An attempt is in flight and has not been called wedged. |
| `stalled` | An attempt is in flight and has occupied the slot for two scheduler ticks without settling. The slot is not freed, because the request has not returned. |
| `backoff` | No attempt is in flight and the consecutive-failure count is above zero. The interval grows with the streak, capped at 30 seconds or at the configured poll interval when that is longer. |
| `idle` | No attempt is in flight and the failure streak is zero, which is also the state before the first attempt. |

The snapshot beside the phase carries `consecutiveFailures`, a count that resets on the next success, three epoch-millisecond fields that are null when they do not apply (`nextAttemptAt`, `attemptStartedAt`, and `lastSuccessAt`), and `lastError`, which is null or an object carrying `code`, `message`, and the epoch milliseconds it was recorded at. The [React](https://react.dev) and [Vue](https://vuejs.org) `useSyncStatus` bindings surface the same value under the name `nextRetryAt`, so the phase is the stable field to branch on. [Sync health](./javascript/sync-health.md) documents the type and the subscription.

## Attachment states

One attachment row moves through seven states. Upload runs `queued` to `uploading` to `synced`; download, which is lazy and starts on first use, runs `queued` to `downloading` to `synced`. Every app client mounts the same queue and uses the same seven values.

| State | Meaning |
|---|---|
| `queued` | Waiting for the queue. A row pulled from a peer starts here and stays until something views it. |
| `uploading` | Bytes are moving to Storage. |
| `downloading` | Bytes are moving from Storage into the local sandbox. |
| `synced` | The bytes are in the sandbox and the server has the metadata. |
| `failed` | The last attempt threw. Retryable: the next sync picks the row up again and the attempt counter grows. |
| `orphaned` | Server evidence, an applied push verdict or a pulled row or tombstone, says this device's own object no longer belongs to any row, and no local row or queued write still names it. Waiting for vacuum to remove the Storage object. |
| `evicted` | This device dropped the reference with no such evidence, another user's object or one that only left this device, or gave up on an `orphaned` removal Storage refused or that spent its attempt budget. Vacuum deletes only the cached bytes; the row keeps its hash, size, and media type, and the Storage object stays as it is. |

A download that fails because the peer's bytes are not uploaded returns to `queued` rather than `failed`, so a normal race does not look like an error. [Attachment state lifecycle](../attachments/media-and-attachments.md#attachment-state-lifecycle) shows the same states in an app.

Five transfer error codes travel on the thrown error's `code` and decide what the queue does next.

| Code | Condition | Queue effect |
|---|---|---|
| `ATTACHMENT_NOT_YET_AVAILABLE` | A peer's download met a [404 from Storage](https://supabase.com/docs/guides/storage/debugging/error-codes#404-notfound) because the bytes are not uploaded. | Back to `queued`, and the attempt still counts against the budget |
| `ATTACHMENT_UPLOAD_EXPIRED` | The offset probe on a [resumable upload URL](https://supabase.com/docs/guides/storage/uploads/resumable-uploads#upload-url) answered `404` or `410`, so it cannot be resumed. | `failed`, and the stale fingerprint is dropped so the next attempt restarts from zero |
| `ATTACHMENT_TRANSFER_TIMEOUT` | An adapter deadline beat a hung network call. | `failed`, and the session survives, so a later attempt resumes |
| `ATTACHMENT_UNVERIFIED` | A download has no SHA-256 to verify against, from the server's own metadata or from this device's own record. | `failed`, and the attempt still counts against the budget; retryable through [`retry(ref)`](./javascript/attachment-retry.md), since a download outside a sync runs only on demand |
| `ATTACHMENT_HASH_MISMATCH` | The downloaded bytes do not match the SHA-256 the row names. | `failed`, and the attempt still counts against the budget; retryable through [`retry(ref)`](./javascript/attachment-retry.md), since a download outside a sync runs only on demand |

The server-side row in [`kizunasync.attachments`](./sql-pack.md#kizunasyncattachments) has no lifecycle column. It exists only after `attachment_confirm` has run, and `attachment_vacuum` deletes it rather than marking it gone.

## Rejection kinds

The engine journals a queued write that dies under one of four kinds. The journal is a client-local record rather than deduplication machinery. [Rejections](./javascript/rejections.md) reads it.

| Kind | Source |
|---|---|
| `REJECTED` | A per-mutation verdict came back rejected. |
| `SUPERSEDED` | A per-mutation verdict came back rejected with the [HLC](../resources/glossary.md#hybrid-logical-clock-hlc) reason, recorded separately so an app can treat a lost race differently from a refused write. |
| `BATCH_ABORTED` | An atomic batch returned one abort outcome. The entry is recorded for the offender only, because the sibling reverts are consequences rather than verdicts. |
| `DEAD_LETTER` | The retry budget ran out, or an atomic batch's server-side size refusal (`KZP02`) dead-lettered it at once. The reason is `PERMANENT_TRANSPORT` for the budget case, and the server's own message for a `KZP02` batch. |

Each journal row carries the mutation ID, table, primary key, kind, reason, the columns the mutation changed, the server row the verdict carried, the epoch milliseconds, and whether the user dismissed it.

## Wire status values

These come from the protocol rather than from the client, and [Protocol reference](./protocol.md) is where each one's exact condition lives.

| Vocabulary | Members | Owner |
|---|---|---|
| Verdict kind | `applied`, `rejected` | [Push response](./protocol.md#push-response) |
| Rejection reason | `COLUMN_DENIED`, `CONSTRAINT`, `DELETE_WINS`, `PRECONDITION`, `RLS_DENIED`, `SUPERSEDED` | [Rejection reasons](./protocol.md#rejection-reasons) |
| Batch outcome | `aborted` | [Push response](./protocol.md#push-response) |
| Lifecycle signal | `CHECKPOINT_EXPIRED`, `RESET_REQUIRED` | [Lifecycle signals](./protocol.md#lifecycle-signals) |

`RLS_DENIED` is the one reason with a deliberate ambiguity: it covers both a row [a policy hides](https://supabase.com/docs/guides/database/postgres/row-level-security#select-policies) and a row that does not exist, because distinguishing them would leak the difference. Kizuna adds no second authorization layer over those policies.

The engine also throws typed error codes that are not statuses, among them `LOCAL_UNSUPPORTED`, `LOCAL_CONSTRAINT`, `BUCKET_UNSET`, `SOFT_DELETE_VIOLATION`, and `ATTACHMENT_PORTS_MISSING`. Each is documented in the Errors section of the reference entry that throws it, and [Troubleshooting](../operations/troubleshooting.md#quick-reference) collects the ones readers hit most.

## What a maturity claim must name

The repository does not package a complete standalone third-party driver TCK, so a maturity claim about a driver has to say which evidence produced it. These lanes answer different questions and none substitutes for another.

- Port tests exercise one adapter against its interface.
- The shared protocol corpus replays recorded request and response bytes.
- Live service tests call a real Supabase project.
- Device tests run on physical hardware rather than a simulator.
- Multi-process tests open the same database from more than one process.
- Kill and recovery tests terminate the process and check what survived.

[Drivers and the TCK](./drivers-and-tck.md#what-a-driver-needs-beyond-the-corpus) sets out what each lane owes a driver author, and [Match the test to the claim](../operations/test-offline-behavior.md#6-match-the-test-to-the-claim) names which suite in this repository backs which claim.

## Related reference

- [Project status](../getting-started/status.md): the maturity labels applied surface by surface.
- [Protocol reference](./protocol.md): the wire vocabularies in full.
- [Drivers and the TCK](./drivers-and-tck.md): the evidence lanes behind a driver claim.
- [Protocol decisions](../resources/protocol-decisions.md): every decision record and its status.
- [Roadmap](../resources/roadmap.md): what the remaining statuses are waiting on.
