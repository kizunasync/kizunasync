/**
 * `KSYNC_SKIP_RUST` and `KSYNC_REQUIRE_RUST` are read as `'1'` or `'true'`;
 * every other value, including unset, is false. Each script decides what
 * skipping or requiring Rust means for its own gate; see that script's header.
 */
export function isRustSkipped(): boolean {
  return process.env.KSYNC_SKIP_RUST === '1' || process.env.KSYNC_SKIP_RUST === 'true'
}

export function isRustRequired(): boolean {
  return process.env.KSYNC_REQUIRE_RUST === '1' || process.env.KSYNC_REQUIRE_RUST === 'true'
}

export function cargoOnPath(): boolean {
  return Bun.which('cargo') !== null
}
