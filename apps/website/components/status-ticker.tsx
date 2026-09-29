// MARK: - StatusTicker

/**
 * The fields useSyncStatus exposes: connectivity, synchronization activity,
 * outbox depth, and checkpoint state. Not a live measurement. Reduced motion
 * freezes on the first server-rendered line.
 */
const STATES = [
  'ONLINE · IDLE · OUTBOX 0 · CURSOR 42 · SCHEMA 1 · SOFT-BLOCK FALSE',
  'OFFLINE · IDLE · OUTBOX 1 · CURSOR 42 · SCHEMA 1 · SOFT-BLOCK FALSE',
  'ONLINE · SYNCING · OUTBOX 1 · CURSOR 42 · SCHEMA 1 · SOFT-BLOCK FALSE',
  'ONLINE · IDLE · OUTBOX 0 · CURSOR 43 · SCHEMA 1 · SOFT-BLOCK FALSE',
] as const

export function StatusTicker() {
  return (
    <p
      className="ticker-strip text-site-faint mx-auto mt-6 max-w-full font-mono text-[11px] tracking-wide sm:text-xs"
      aria-hidden="true"
    >
      {STATES.map((state, index) => (
        <span key={state} className="ticker-line" style={{ ['--tick' as string]: index }}>
          {state}
        </span>
      ))}
    </p>
  )
}
