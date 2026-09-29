<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">TLC model-checking tools</span>
</h1>

`tla2tools.jar` is the TLA+ tools bundle (TLC model checker, SANY parser).

## What this is

| | |
|---|---|
| Version | TLA+ Tools 1.8.0 (`tla2tools.jar`) |
| Download | `https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar` |
| SHA-256 | `8836549e83db7f0b3f9fdde679ab56270d18e06198366d217d960738c02b9dbe` |
| License | MIT (TLA+ Tools) |

The jar is not committed (gitignored under `tools/.gitignore`). `run-tlc.sh` downloads it on first `check:tla` run and verifies the SHA-256 above. It is not a runtime dependency of `@kizunasync/protocol` and is never imported by published code. The `bun test` lane does not invoke it.

## Prerequisites

A Java runtime (JRE/JDK 17 or newer) on `PATH`. Check with `java -version`. CI installs Temurin JDK 17. TLC needs nothing else.

## Run

```sh
# single module
tools/run-tlc.sh prop_001_cursor_monotonic

# all modules, from packages/protocol/
bun run check:tla
```

Expected success line: `Model checking completed. No error has been found.`

## Jar management

On first run `run-tlc.sh` downloads the pinned v1.8.0 release and verifies the checksum. A mismatch exits non-zero. To upgrade, update the URL, `EXPECTED_SHA`, and the SHA-256 in this README together.

## Related

- [`@kizunasync/protocol`](../README.md)
- [Protocol reference](../../../docs/reference/protocol.md)
