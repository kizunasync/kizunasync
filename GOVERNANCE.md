---
title: Governance
status: alpha
docType: concept
---

# Governance

These commitments bind current and future maintainers. They exist because the ecosystem has shown where open sync projects go wrong, so this document designs those failure modes out in writing.

## 1. Licensing

- Every current npm workspace except the server SQL pack, every current Rust crate, the protocol and conformance corpus, the drivers, framework bindings, CLI, website, demo, and sync inspector declare Apache-2.0. Contributions use DCO sign-off, not CLAs, as [CONTRIBUTING.md](./CONTRIBUTING.md#ground-rules) sets out.
- The server SQL pack (`packages/supabase-pack`) declares PolyForm Shield 1.0.0 © Smart Squad S.r.l., and a future hosted control plane will use the same license. It is source-available and excludes use to offer a competing product. Because the wire protocol is Apache-2.0, another implementation can target it independently.
- Any future management panel remains Apache-2.0, self-hostable, and free of feature gating. The current repository contains the local read-only sync inspector, not a hosted management panel.
- We use exactly one source-available license, PolyForm Shield, and it applies only to the server pack and the control plane above. We do not use SSPL, we do not use a BSL time-bomb, and we do not put the engine or the drivers behind a paid open-core tier. The license protects the managed service from a competitor and does nothing else. It never gates correctness, performance, platforms, the drivers, or the panel, all of which stay Apache-2.0. If a paid offering ever exists, it will cover operational convenience and support only, never correctness, performance, or platforms.

## 2. Drivers are never premium

All first-party drivers remain permissively licensed. Performance-critical drivers are never license-gated. If a community-driver registry is introduced, listing is free.

The SPI boundary is a natural place to introduce platform paywalls. This commitment keeps every supported first-party storage path available on the same licensing terms, and it prevents a paid driver from becoming a dependency of the documented path. [Drivers and the TCK](./docs/reference/drivers-and-tck.md#port-model) describes the boundary the commitment protects.

## 3. The local database is the user's

The current clients contain no telemetry path. The local sync inspector uses only the project URL and keys explicitly supplied by its operator, and its service-role key stays in server-only code. A future hosted panel may store OAuth refresh tokens, never service-role keys; that is a product constraint, not a description of software already present.

A planned CLI adoption ping is the only telemetry Kizuna may ever add. This document binds it in advance of any code. It lives solely in the interactive `kizunasync init` wizard, as an explicit consent prompt with a visible default. It never runs in a non-interactive session. One consent sends one event. Its field list is closed and published verbatim before the feature ships. The fields are tool and pack versions, operating system and architecture, and a random identifier minted locally. The event never carries a URL, a key, a schema or table name, a row count, or anything derived from user data. The receiving endpoint retains no request addresses. `KSYNC_TELEMETRY_DISABLED=1` wins over any stored consent. The ping never extends to the synced clients or drivers, whose no-telemetry guarantee above is unconditional. This is a product constraint rather than a description of software already present. [CLI adoption ping](./docs/resources/roadmap.md#cli-adoption-ping) carries the sequencing.

## 4. Protocol & SPI stability

- The [conformance corpus](./docs/resources/glossary.md#conformance-corpus) is the single oracle. Breaking protocol changes require an RFC with a public comment window. Nothing on the wire carries a protocol version field; `schema_version` is the application's table schema, not a Kizuna protocol version.
- `IStoreLocator` is exported but is alpha and may change before the first stable release. Once an SPI is declared stable, additive capabilities use minor releases.
- Driver certification and expiry badges are planned policy only: the repository has no driver registry and no certification report.

## 5. RFC process

Substantive changes to the protocol, the SPI, the SQL pack shape, or the consistency claims go through an RFC-labeled PR. That PR touches `packages/protocol/` and carries the conformance-corpus update with it. The RFC states the problem, the design, the alternatives, and the migration. Maintainers merge it with a rationale. A rejected RFC stays in the record as the closed PR plus its decision note and reason. `packages/protocol/` is the canonical seat and there is no separate `rfcs/` directory, which matches CONVENTIONS.md and packages/protocol/README.md. [Protocol decisions](./docs/resources/protocol-decisions.md) reads that register back in the words the rest of the documentation uses.

## 6. Honesty rules (docs as contract)

- Consistency claims use the guarantees and non-guarantees in [`docs/sync/consistency-model.md`](./docs/sync/consistency-model.md), and never market Kizuna as a [CRDT](https://grokipedia.com/page/Conflict-free_replicated_data_type) or serializable database.
- We publish the compatibility matrix of the local client, unsupported constructs throw typed errors, and there are no silent network fallbacks.
- The fit and non-fit guidance in [`docs/getting-started/introduction.md`](docs/getting-started/introduction.md) states when Kizuna is the wrong tool and points readers toward the relevant alternative category.

## Related pages

- [Contributing](./CONTRIBUTING.md)
- [Roadmap](./docs/resources/roadmap.md)
- [Project status](./docs/getting-started/status.md)
