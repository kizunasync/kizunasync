# D-row-key: A row is keyed by its table's primary key, sent as canonical text

<!-- kizunasync:decision
id: D-row-key
status: decided
-->

**Cites:** P:mutations-and-column-masked-conflict-resolution, P:keyset-pagination-and-delivery-bound, SQL:row-key, SQL:config-key-columns, SQL:insert-key-authority, SQL:column-privilege-gate

## Question

Which columns identify a synced row, and what text does `pk` carry for them on the wire, in the SQL pack's bookkeeping, and in the engine's local store?

## Decision

### Key columns

A synced table's key columns are its primary-key columns in index order, the `pg_index.indkey` of the table's `indisprimary` index. A key column's type is `uuid`, `text`, `character varying`, `smallint`, `integer`, or `bigint`. Provisioning refuses a table without a primary key, and a table whose key has a column of any other type (`numeric`, floating point, date and time types, `boolean`, `bytea`, `char(n)`, arrays, a domain over another type, and so on), because the text form of such a value is not guaranteed identical on the device and on the server. A table with an `attachment()` column keeps the single `id` uuid key, because object paths embed it.

### Canonical text

The component text of a key column is its value as `to_jsonb(row) ->> column` renders it: a uuid in lowercase hyphenated form, an integer as a plain decimal with an optional leading `-`, and text unchanged. With one key column, `pk` is that component text, so a table keyed by one uuid column carries the uuid itself. With several, `pk` is the JSON array of the component texts, every one a JSON string, in the Postgres jsonb text form: `[`, the components joined by `, ` (a comma and a space), then `]`. A component escapes only `"`, `\`, and U+0000 to U+001F, as `\b`, `\f`, `\n`, `\r`, and `\t` where those exist and as `\u00XX` in lowercase hex otherwise, so a key of `(1, 3456)` is `["1", "3456"]`. SQL builds the text with `jsonb_build_array(<component texts>)::text` and reads component `i` back with `pk::jsonb ->> i`.

The Rust engine derives `pk` on the device, and hosts never compute it. [`vectors/row-key-vectors.json`](../vectors/row-key-vectors.json) holds the vectors both the SQL pack and the engine must render byte for byte.

### Server rules

- `_config.key_columns` (`text[] not null default '{id}'`, at least one column) records a table's key columns.
- Every `pk` column of the bookkeeping tables and every `pk` parameter of the pack's functions is `text`, and the capture triggers compute `pk` from `key_columns`.
- A lookup of the row a `pk` names casts the pk side only, `t.a = $1::bigint` or `t.a = ($1::jsonb ->> 0)::bigint and t.b = ($1::jsonb ->> 1)::integer`, so the key's own index serves it. One helper builds that predicate from the key columns and their types, quoting every identifier and accepting only the key types above, for every statement that finds one row by its key.
- A row is readable only when every key column is.
- The pk decides an insert's key. Key columns that `columns` leaves out are filled from the decoded pk, and a key column that `columns` names must render, through its column type, to the same component text; otherwise the mutation is rejected `CONSTRAINT`.
- Key columns are immutable. A key column in an update's `columns` or `transforms` answers `COLUMN_DENIED`.
- The push guard refuses the whole batch with SQLSTATE `22023` when a `pk` is not the canonical key text of its table: not a non-empty string, not a JSON array of exactly as many strings as the key has columns, a component the key column's type refuses, or a text that decoding, casting to the key types, and rendering back does not reproduce byte for byte, such as an uppercase uuid, a leading zero, or a composite spelled with other spacing.
- A key column generated always as identity takes no value from a push, so an insert that names it is rejected `CONSTRAINT` for that mutation alone. The CLI refuses such a table as read-write.
- A table with the capture triggers and no `_config` row is not synced: its writes queue nothing, and a direct write never fails because of Kizuna.

### Client obligations

- A table's config carries `key`: the `defineConfig` table option `key?: string | readonly string[]`, `'id'` by default, and `KizunaSyncTableConfig(key: [String] = ["id"])` in Swift and Kotlin. The engine config receives it only when it differs from `["id"]`, in the same bytes from every host.
- The engine refuses with `CONFIG_INVALID` a key that is empty, holds something other than a string, or repeats a column, and a key other than `["id"]` on a table with attachment columns.
- On insert, a key of `["id"]` with no `id` in the row mints a uuid. Otherwise every key column must be present, non-null, and a string or an integer JSON number, and the engine refuses the write with `LOCAL_CONSTRAINT` naming the columns that are missing or invalid; `pk` then follows the rule above.
- An update or a transform that touches a key column fails with `LOCAL_CONSTRAINT`, because the key is immutable.
- The local query fast path keyed on `id` serves the single key column of any one-column key, for `eq` and `in`. A composite key takes the full path.
- A read-write table keyed by an identity column has no value a device can generate offline, so a device must pass the key on every insert. Tables devices create rows in suit uuid keys.

`pull/006-integer-key-pull-only` pins the bytes of a bigint key on a pull-only table, and `push/008-composite-key-writes` pins an insert, an update of a column outside the key, and a delete on a table keyed by a pair of integers. An engine derives every pk from the key columns, so no transcript carries an insert whose key column disagrees with its pk; the SQL pack's own tests cover that `CONSTRAINT`, the `COLUMN_DENIED` of a key column, and the guard's refusals.

## Rejected

- **A uuid column named `id` as the only key.** A synced table syncs by the key it already has, so an application keeps its schema.
- **Any column type as a key.** A type whose text form can differ between the device and the server would let the two sides spell one row two ways.
- **A cast on the column side of a lookup (`t.a::text = $1`).** The key's index could not serve the lookup, so every row lookup would read the whole table.
