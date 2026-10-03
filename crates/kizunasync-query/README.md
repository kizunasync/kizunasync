<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">kizunasync-query</span>
</h1>

Local evaluation of a `TQueryPlan`. Filters, the optional exact count, order, offset, limit, and cardinality run against in-memory rows the store already loaded. The kernel calls this crate and nowhere else: a JavaScript host translates PostgREST clause strings into plan nodes, then the same evaluator answers. Private workspace member (`publish = false`).

Parity vectors in `tests/parity_vectors.rs` load `packages/core/src/query/parity-vectors.json` and replay them through this evaluator. An operator the local subset does not implement returns `LOCAL_UNSUPPORTED`. A cardinality miss returns `LOCAL_CONSTRAINT`.

## Get started

```sh
cargo test -p kizunasync-query
```

## Related

- [kizunasync-store](../kizunasync-store/README.md)
- [kizunasync-engine](../kizunasync-engine/README.md)
- [Repository layout](../../docs/resources/repository-layout.md)
