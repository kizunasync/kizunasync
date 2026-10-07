/**
 * Finds the Docker container of the local Supabase database for the tests that
 * run a client binary or read /proc inside it. The classic stack names it
 * `supabase_db_kizunasync`; the experimental `supabase stack` names it per instance.
 */

const CLASSIC_CONTAINER = 'supabase_db_kizunasync'
const DATABASE_LABEL_FILTER = 'label=com.supabase.service=database'

/** Runs a command and returns its trimmed stdout, or null when it fails or the binary is missing. */
function capture(command: string[]): string | null {
  try {
    const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'ignore' })

    return result.exitCode === 0 ? result.stdout.toString().trim() : null
  } catch {
    return null
  }
}

/**
 * The database container name: `KSYNC_DB_CONTAINER` when set; else the classic
 * stack's container when `docker inspect` finds it; else the single running
 * container labelled `com.supabase.service=database`; else null (no Docker, or
 * the native runtime, which runs no container). Never throws.
 */
export function resolveDbContainer(): string | null {
  const configured = process.env.KSYNC_DB_CONTAINER

  if (configured) {
    return configured
  }
  if (capture(['docker', 'inspect', CLASSIC_CONTAINER]) !== null) {
    return CLASSIC_CONTAINER
  }
  const names = (capture(['docker', 'ps', '--filter', DATABASE_LABEL_FILTER, '--format', '{{.Names}}']) ?? '')
    .split('\n')
    .filter((name) => name !== '')

  return names.length === 1 ? (names[0] ?? null) : null
}
