// MARK: - Client-under-test contract

/**
 * The seam the client executor drives: the mirror of packages/protocol/executor's
 * IProtocolServer, but for the CLIENT engine. Where the server contract
 * answers RPCs, this contract DRIVES them: the executor interprets a
 * transcript's `local` / `rpc` / `fault` / `assert` steps against an
 * implementation of this interface (transport-client.ts wraps the Rust engine
 * behind an `IEngineTransport` plus a TranscriptRemote to satisfy it).
 *
 * The rpc-bearing methods (pull/push/injectFault) take the transcript step so
 * the adapter can prime its TranscriptRemote with the golden request/response
 * pair for THAT step before triggering the engine's wire call. Every method on
 * the seam carries its own step, applyLocal and injectFault included, so one
 * rule covers all of them.
 *
 * Determinism rule (mirrors server-contract.ts): no Date.now, no Math.random
 * anywhere the executor reaches.
 */

// MARK: - Transcript step

/**
 * A single `steps[]` entry. Validated structurally by the protocol harness
 * (invariant I-2) before it ever reaches us; we read the discriminant fields
 * (kind, rpc, request, response, op, columns, …) by key, exactly as
 * packages/protocol/executor/executor.ts does.
 */
export type TTranscriptStep = Record<string, unknown>

// MARK: - Readable row projection

/**
 * What `local-row` checks compare against: the column map ({ column: value })
 * of a locally readable row, or null when the row is absent (deleted or never
 * present: transcript.schema.json check `local-row`, row:null = absent).
 * Decoupled from the engine's internal TLocalRow shape: the adapter projects
 * TLocalRow down to this column map (the only layer that knows how the engine
 * exposes a row), so the check stays a pure column comparison.
 */
export type TReadableRow = { columns: Record<string, unknown> } | null

// MARK: - The contract

export interface IProtocolClient {
  /** `local` step: client-local write + outbox enqueue in one txn (P:outbox-and-serial-in-flight). */
  applyLocal(step: TTranscriptStep): Promise<void>

  /**
   * `rpc` step, rpc:'pull': drive one pull; the engine's pull request bytes are
   * asserted byte-exact against step.request and step.response is replayed.
   */
  pull(step: TTranscriptStep): Promise<void>

  /**
   * `rpc` step, rpc:'push': drive one push; request bytes asserted, response
   * verdicts replayed.
   */
  push(step: TTranscriptStep): Promise<void>

  /**
   * `fault` step: drop-ack (server applied, ack lost ⇒ engine retries on the
   * next rpc) or transport-error (never applied ⇒ engine leaves the work
   * queued / cursor untouched).
   */
  injectFault(step: TTranscriptStep): Promise<void>

  /** `local-row` check: null = absent. */
  readRow(table: string, pk: string): Promise<TReadableRow>

  /** `cursor` check: the durably persisted client cursor (decimal string). */
  cursor(): Promise<string>

  /** `outbox-depth` check: pending outbox entry count. */
  outboxDepth(): Promise<number>

  /**
   * `event` check: the typed events emitted so far (drained buffer fed by
   * engine.subscribe).
   */
  drainedEvents(): string[]

  /**
   * Resume precondition: seed the durably persisted cursor BEFORE the steps run,
   * for transcripts that open mid-history (the client resumed from a non-'0'
   * checkpoint documented only in prose context.notes). A no-op at '0'.
   */
  seedCheckpoint(cursor: string): Promise<void>

  /**
   * Conformance precondition for the PUSH side. The transcript's `local` step
   * grammar (transcript.schema.json) carries mutation_id but NOT precondition,
   * yet the golden push request DOES carry both (push/004). The executor
   * pre-loads, in apply order, each local mutation's pinned id AND its
   * precondition (recovered by mutation_id from the push request bytes) BEFORE
   * the steps run:
   *   - the id feeds the engine's uuid() so the minted mutation_id matches the
   *     golden push bytes byte-for-byte.
   *   - the precondition is attached to the matching apply() so the engine emits
   *     it on the push request (push/004's CAS claim).
   * Empty for pull-only cases (apply is never called); the pull path is
   * unaffected. precondition is omitted when the mutation carries none.
   */
  seedLocalMutations(specs: TLocalMutationSpec[]): void
}

// MARK: - Local-mutation seed spec

/**
 * One entry of the ordered local-mutation feed (see seedLocalMutations). The
 * precondition is the Bayou-style expected column mask the push request pins
 * (recovered by mutation_id); absent when the mutation has none. batchId groups
 * the mutations of one atomic push (recovered from the push step whose
 * batch.atomic is true, push/005); absent for an independent, non-atomic write.
 */
export type TLocalMutationSpec = {
  mutationId: string
  precondition?: import('../wire/types').TColumnValues
  batchId?: string

  /**
   * The origin HLC the push request pins for an hlc-mode mutation (recovered by
   * mutation_id from the push bytes, mirroring the precondition recovery). Fed to
   * the engine so it emits the transcript's pinned hlc (conflict/003); absent
   * for arrival-mode mutations (the engine attaches no hlc there).
   */
  hlc?: string

  transforms?: Record<string, import('../wire/wire-types.generated').TTransform>
}
