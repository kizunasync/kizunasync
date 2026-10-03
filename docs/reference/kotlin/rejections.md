---
title: List rejections
description: Read the journal of writes the server refused or the client dropped.
status: alpha
docType: reference
library: kotlin
pageKind: method
audience: app-developer
---

# Kotlin: List rejections

`rejections(includeDismissed)` reads the local journal a run writes when a write does not survive: the server refused it, an atomic batch it belonged to was aborted, or the retry budget dropped it. Each entry carries the row the server had at the time, so a screen can explain what happened and offer the user a choice.

## Examples

### Basic

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
val entries = kizunasync.rejections()
for (entry in entries) {
    println("${entry.table}/${entry.pk} ${entry.kind} ${entry.reason}")
}
```

### Show the server's version of the row

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import org.json.JSONObject

val entry = kizunasync.rejections().firstOrNull() ?: return
val serverRow = if (entry.serverRowJson.isEmpty()) null else JSONObject(entry.serverRowJson)
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `includeDismissed` | `Boolean` | No | Whether entries already acknowledged with [Dismiss a rejection](./dismiss-rejection.md) are returned. Default: `false`. |

## Returns

`List<KizunaSyncRejection>`, newest first, with these fields.

| Name | Type | Required | Description |
|---|---|---|---|
| `mutationId` | `String` | — | Id of the write that failed, the same value passed to [Insert data](./insert-data.md#parameters) or generated for it. |
| `table` | `String` | — | Table the write targeted. |
| `pk` | `String` | — | Primary key the write targeted. |
| `kind` | `String` | — | `REJECTED` for an ordinary refusal, `SUPERSEDED` when a newer write won, `BATCH_ABORTED` for the offender of an atomic batch, and `DEAD_LETTER` for a write the retry budget dropped. |
| `reason` | `String` | — | `RLS_DENIED`, `COLUMN_DENIED`, `CONSTRAINT`, `PRECONDITION`, `DELETE_WINS`, or `SUPERSEDED` from the server, and `PERMANENT_TRANSPORT` on a dead letter, except a batch-too-large refusal (`KZP02`) of an atomic batch, whose reason is the server's own message. |
| `changedColumns` | `List<String>` | — | The column names the refused write carried. |
| `serverRowJson` | `String` | — | The row as the server's own policies rendered it, encoded as JSON. Empty when the server sent none, for example because the row is hidden from this user. |
| `at` | `Long` | — | When the entry was journalled, in milliseconds since the Unix epoch. |
| `dismissed` | `Boolean` | — | Whether the entry has been acknowledged. Always `false` unless `includeDismissed` is `true`. |

## Errors

| Code | Condition |
|---|---|
| `STORE`, `JSON` | The journal could not be read or its stored columns could not be parsed. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

The engine reverts a refused write before it appears here. The local row already holds the server's version, so the journal is a record rather than a queue to drain. Re-journalling the same mutation id replaces the entry and clears its dismissal.

`MUTATION_REJECTED` on [Subscribe to events](./on.md#returns) fires as each entry lands, which is the cue to re-read this list. [Validate writes](../../sync/validate-writes.md#4-read-the-journal-in-the-app) shows the screen this list is meant for, and Supabase documents the policies behind a `RLS_DENIED` under [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#what-a-policy-does).

## Related reference

- [Dismiss a rejection](./dismiss-rejection.md)
- [Push once](./push-once.md)
- [Subscribe to events](./on.md)
- [Types](./types.md)
- [Swift: List rejections](../swift/rejections.md)
- [JavaScript: List rejections](../javascript/rejections.md)
