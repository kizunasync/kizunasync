---
title: Using transforms
description: Increment a counter and edit a set without reading the row first.
status: alpha
docType: reference
library: swift
pageKind: guide
audience: app-developer
---

# Swift: Using transforms

A transform describes a change to one column rather than the value that column ends with, so two devices that both raise a counter offline end at the sum instead of one overwriting the other. Transforms travel with the mutation on [Update data](./update-data.md) and [Write with filters](./apply-where.md), keyed by column name.

## Supported transforms

| Name | Type | Required | Description |
|---|---|---|---|
| `increment` | `["op": "increment", "by": Int \| String]` | `by` is required | Adds `by` to the current value, treating a missing or null column as `0`. `by` is a signed integer, either a number or a decimal string; the stored result switches to a string past the 32-bit range. |
| `arrayUnion` | `["op": "arrayUnion", "values": [Any]]` | `values` is required | Appends each member of `values` that the array does not already hold, comparing members by their JSON form. A column that is missing or not an array starts from an empty array. |
| `arrayRemove` | `["op": "arrayRemove", "values": [Any]]` | `values` is required | Drops every member equal to one of `values`, comparing members by their JSON form. A column that is missing or not an array yields an empty array. |

## Usage

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

try await kizunasync.apply(
  table: "todos",
  pk: todoId,
  op: .update,
  columns: [:],
  transforms: [
    "views": ["op": "increment", "by": 1],
    "tags": ["op": "arrayUnion", "values": ["offline"]]
  ]
)
```

A transform rides on an update rather than replacing it, and the same call may assign plain columns at the same time. The engine applies the assignments first and the transforms on top of the result.

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

try await kizunasync.apply(
  table: "todos",
  pk: todoId,
  op: .update,
  columns: ["done": true],
  transforms: ["views": ["op": "increment", "by": 1]]
)
```

## Errors

A malformed transform throws `LOCAL_CONSTRAINT` before anything is written: an entry that is not an object, a missing `op`, an `op` outside the three names above, an `increment` without `by` or with a `by` that is not a signed integer, or an `arrayUnion` or `arrayRemove` without a `values` array. A `by` of null counts as zero, and a column whose current value is not an integer is left as it is rather than raising.

## Notes

The local row changes at once and the transform is replayed against the server row when the push lands, so the value a peer reads after sync is the merged one rather than the local guess. [Collaborative fields](../../sync/collaborative-fields.md#2-count-with-increment) shows the pattern in an app, including the case a transform cannot fix. The insert path writes plain columns only, so a transform on an insert changes nothing locally.

## Related reference

- [Update data](./update-data.md)
- [Write with filters](./apply-where.md)
- [Sync](./sync.md)
- [Kotlin: Using transforms](../kotlin/using-transforms.md)
- [JavaScript: Using transforms](../javascript/using-transforms.md)
