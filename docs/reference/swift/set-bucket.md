---
title: Set bucket
description: Fill the bucket parameters the pull request is scoped by.
status: alpha
docType: reference
library: swift
pageKind: method
audience: app-developer
---

# Swift: Set bucket

`setBucket(_:)` writes values into the bucket parameters of the tables configured with `.byColumn`, so a pull can ask for the rows of one team or project. It fills the keys the configuration declares as bucket columns and refuses the whole call when any key is not one of them. A table configured with `.byOwner` needs no call: the engine fills its bucket with the user the session token names, as [Set access token](./set-access-token.md#notes) describes.

## Examples

### After the open

```swift
// TodoApp/TodoSync.swift (excerpt)
import KizunaSync

try await kizunasync.setBucket(["team_id": teamId])
```

This example assumes a `todos` table configured with `bucket: .byColumn("team_id")`, and `teamId` is the app's own value, such as the team the signed-in user belongs to. The engine restores no `.byColumn` value when it opens, so the app sets it after every `create(_:)` and before it starts the [Host scheduler](./scheduler.md).

### Switching to another team

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

try await kizunasync.setBucket(["team_id": nextTeamId])
syncScheduler.wake()
```

A `nextTeamId` that differs from the one this device already kept for that key replaces the local scope: the run the wake starts re-bootstraps every table sharing the key, and its closing pull boundary drops every row the new value does not carry. Queued writes survive the switch. [Reset](./reset.md) is a heavier, separate operation: it also empties the outbox and the rejection and overwrite journals, and mints a new client identity.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `params` | `[String: Any]` | Yes | Values keyed by bucket column. Every configured table whose bucket column is a key gets that value, and a bucket no key names keeps its current value. Each key has to be the bucket column of at least one configured table, `.byColumn` or `.byOwner`; any other key refuses the whole call with `BUCKET_UNSET`. |

## Returns

`Void`. The values live in the open engine, not in the database, so each [Initializing](./initializing.md) call starts without them: the app sets them again after every open rather than restoring them from the file. An owner bucket is the exception, because the engine fills it from the owner the database keeps.

## Errors

| Code | Condition |
|---|---|
| `JSON` | The engine could not read `params` as a JSON object. |
| `BUCKET_UNSET` | A key in `params` is not the bucket column of any configured table. Its `message` names the key and the configured bucket columns, as in `set_bucket: "team_id" is not a configured bucket column (configured: "user_id")`, and no parameter changes. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

Every code in the table is the `code` on a thrown `KizunaSyncError.engine(code:message:)`; its `description` reads `"CODE: message"`, but match on `code` rather than parsing the string.

A value the platform serializer refuses never reaches the engine: `JSONSerialization` raises inside the client first, so it surfaces as a serialization error rather than an engine code.

## Notes

The store keeps, per table, the last non-empty value it saw for each key, across restarts. A call that replaces one of those kept values with a different non-empty value arms a re-bootstrap: the next pull restarts every table's keyset from `"0"`, and its closing boundary replaces the local snapshot, dropping the rows the new scope does not carry, while every queued write stays untouched. Filling a key the store keeps no value for, clearing it to `""`, or setting the same value again arms nothing. The kept value only decides whether a call re-bootstraps; the engine restores no `.byColumn` value at open, which is why an app calls `setBucket(_:)` again after every `create(_:)`.

A `.byColumn` bucket whose value is still unset, or was cleared to `""`, makes the next pull throw `BUCKET_UNSET` rather than asking for every row, which is the failure [BUCKET_UNSET](../../operations/troubleshooting.md#bucket_unset) explains. A table provisioned without a bucket column and declared with no bucket is a shared table: it pulls every row [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#what-a-policy-does) permits. On the other tables, Kizuna adds the bucket only as a second, coarser filter on top of the policy. A table provisioned with a bucket column refuses an unscoped pull with `KZL01`.

On a `.byOwner` table, a value set here holds until the next open, when the engine fills the bucket from the owner again, or until [Reset](./reset.md), which clears it. The first token that records an owner overwrites a value set before it.

[Sync rules and buckets](../../sync/sync-rules-and-buckets.md#3-choose-the-right-bucket-helper) explains which column to scope a table by, and [Set access token](./set-access-token.md) covers the other half of a sign-in.

## Related reference

- [Sync](./sync.md)
- [Pull once](./pull-once.md)
- [Set access token](./set-access-token.md)
- [Reset](./reset.md)
- [Kotlin: Set bucket](../kotlin/set-bucket.md)
- [JavaScript: Set bucket](../javascript/set-bucket.md)
