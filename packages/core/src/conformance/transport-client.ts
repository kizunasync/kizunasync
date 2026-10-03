// MARK: - Transport client adapter

/**
 * The only implementation of `IProtocolClient`: it drives the Rust engine through
 * the `IEngineTransport` port, the NAPI addon on Bun or the worker's wasm engine
 * in a browser. One executor, one corpus, either bridge.
 *
 * It mirrors `crates/kizunasync-conformance/src/lib.rs` call for call, with the
 * `TranscriptRemote` standing in for that executor's `ScriptedRemote` (the golden
 * request bytes are asserted where the Rust harness compares `last_pull` /
 * `last_push`):
 *
 *   applyLocal    → call('apply', …)               (run_transcript `local` arm)
 *   pull          → prime remote, call('pull_once') (run_transcript `pull` arm)
 *   push          → prime remote, call('push_once') (run_transcript `push` arm)
 *   injectFault   → prime fault, pull_once or push_once MUST fail
 *                                                   (inject_fault)
 *   readRow       → call('read', …)                (apply_check 'local-row')
 *   cursor        → call('checkpoint').cursor      (apply_check 'cursor')
 *   outboxDepth   → call('outbox_depth')           (apply_check 'outbox-depth')
 *   drainedEvents → the onEvent buffer             (recent_event_names)
 *   seedCheckpoint → call('seed_checkpoint', …)    (engine.seed_checkpoint)
 *
 * The `expect_error` obligation (D-corpus-soft-delete-and-refusal) is the executor's, exactly as in the
 * TypeScript lane: `applyLocal` re-throws the engine's typed failure and
 * `client-executor.ts` compares its code and the outbox depth.
 */

import { toRustConfig } from '../query/rust-engine'
import { parseCallEnvelope } from '../query/engine-envelope'
import { bridgeRemote, isPullRequest, isPushRequest } from '../query/remote-bridge'
import type { TColumnValues, TEngineConfig } from '../wire/types'
import type { IEngineTransport, TEngineTransportFactory } from '../ports/engine-transport'
import type { IProtocolClient, TLocalMutationSpec, TReadableRow, TTranscriptStep } from './client-contract'
import { RequestDivergenceError } from './transcript-remote'
import type { TranscriptRemote } from './transcript-remote'
import { sameBucketSet } from './bucket-identity'

// MARK: - Deterministic clock

/**
 * The instant `kizunasync-conformance` pins for its whole run. It never rides the wire
 * (pull/push requests carry no client timestamp), so it only dates non-wire
 * bookkeeping and keeps runs reproducible. One owner: every corpus runner, the
 * browser lane included, stamps this value.
 */
export const FIXED_NOW = '2020-01-01T00:00:00.000Z'

// MARK: - Options

export interface ITransportClientOptions {
  /** Opens the engine: the NAPI addon constructor, or a driver's transport. */
  factory: TEngineTransportFactory

  /** Per-transcript config (client-executor.ts `configFromContext`). */
  config: TEngineConfig

  /**
   * The transcript's `context.client_id`: the Rust config requires an identity,
   * and D-client-identity puts it on the wire, so this is the value every request body of
   * the transcript pins.
   */
  clientId: string

  /** The database file the engine opens; `null` ⇒ a private in-memory store. */
  databasePath: string | null

  /** The executor primes it per step; it asserts the engine's request bytes and replays the golden response. */
  remote: TranscriptRemote
}

// MARK: - Step readers

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

// MARK: - Adapter

class TransportClient implements IProtocolClient {
  private readonly transport: IEngineTransport
  private readonly remote: TranscriptRemote
  private readonly events: string[] = []

  /** The buckets this client was configured to emit (configFromContext). */
  private readonly identityBuckets: { params: TColumnValues; table: string }[]

  /**
   * Per-mutation precondition columns. The `local` step grammar carries none, so
   * the executor recovers them from the push request bytes and feeds them in
   * before the steps run.
   */
  private readonly preconditions = new Map<string, TColumnValues>()

  private readonly batchIds = new Map<string, string>()
  private readonly hlcs = new Map<string, string>()

  constructor(options: ITransportClientOptions) {
    this.remote = options.remote
    this.identityBuckets = Object.entries(options.config.tables).map(([table, tableConfig]) => ({
      table,
      params: { ...(tableConfig.bucketParams ?? {}) },
    }))
    this.transport = options.factory(
      JSON.stringify(toRustConfig(options.config, options.clientId)),
      options.databasePath,
      bridgeRemote((request) => this.remote.pull(request), isPullRequest),
      bridgeRemote((request) => this.remote.push(request), isPushRequest),
      (eventJson: string) => {
        this.recordEvent(eventJson)
      },
    )
  }

  // MARK: - The JSON call surface

  /**
   * Every call carries the pinned clock, exactly as `createRustEngine` does, so
   * Rust stamps rows and the outbox with the harness's time, not its own.
   */
  private async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const raw = await this.transport.call(
      method,
      JSON.stringify({ ...params, now: FIXED_NOW, now_ms: Date.parse(FIXED_NOW) }),
    )

    return parseCallEnvelope(raw)
  }

  private recordEvent(eventJson: string): void {
    try {
      const event = JSON.parse(eventJson) as { type?: unknown }
      const name = asText(event.type)

      if (name !== null) {
        this.events.push(name)
      }
    } catch {
      // An unreadable event cannot be thrown back across the FFI callback; the `event` check compares names, so an unnamed one is not one.
    }
  }

  // MARK: - IProtocolClient

  async applyLocal(step: TTranscriptStep): Promise<void> {
    // The step's pinned `mutation_id` is the feed key AND the id the engine stamps, so the emitted push request matches the golden bytes. An absent one (`null`) leaves Rust to mint its own, like the Rust executor's `None`.
    const mutationId = asText(step.mutation_id)
    const pinned = mutationId ?? ''

    await this.call('apply', {
      table: asText(step.table) ?? '',
      pk: asText(step.pk) ?? '',
      op: asText(step.op) ?? 'insert',
      columns: asRecord(step.columns) ?? {},
      transforms: step.transforms ?? null,
      precondition: asRecord(step.precondition) ?? this.preconditions.get(pinned) ?? null,
      batch_id: asText(step.batch_id) ?? this.batchIds.get(pinned) ?? null,
      hlc: asText(step.hlc) ?? this.hlcs.get(pinned) ?? null,
      mutation_id: mutationId,
    })
  }

  async pull(step: TTranscriptStep): Promise<void> {
    const request = asRecord(step.request)

    if (!sameBucketSet(request?.buckets, this.identityBuckets)) {
      // Cross-bucket / empty-param probes (tombstones/003) are server-oracle RPCs. This client cannot emit them without setBucket, and applying them would advance the checkpoint past later sibling pulls from the same cursor. The protocol executor and live SQL own those bytes.
      return
    }
    this.remote.expect(step)
    await this.call('pull_once')
  }

  async push(step: TTranscriptStep): Promise<void> {
    this.remote.expect(step)
    await this.call('push_once')
  }

  async injectFault(step: TTranscriptStep): Promise<void> {
    const target = step.target === 'push' ? 'push' : 'pull'

    this.remote.expectFault(step)
    let survived = false

    try {
      await this.call(target === 'push' ? 'push_once' : 'pull_once')
      survived = true
    } catch (error) {
      if (error instanceof RequestDivergenceError) {
        throw error
      }
      // The primed transport fault IS the step. On pull, the abandoned keyset is what makes the next pull resume from the durable checkpoint (fencing/001). On push, the request WAS sent and its bytes asserted; the server applied it and the acknowledgement was lost, so the mutation must stay queued for the transcript's next push step to replay verbatim (push/003). A client that took the failure as "applied" would clear the outbox here and send nothing to replay.
    }
    if (survived) {
      throw new Error(
        `fault ${asText(step.fault) ?? 'fault'} was primed on ${target} but ${target}_once succeeded`,
      )
    }
  }

  async readRow(table: string, pk: string): Promise<TReadableRow> {
    const row = (await this.call('read', { table, pk })) as { columns: TColumnValues } | null

    return row === null ? null : { columns: row.columns }
  }

  async cursor(): Promise<string> {
    const checkpoint = (await this.call('checkpoint')) as { cursor: string }

    return checkpoint.cursor
  }

  async outboxDepth(): Promise<number> {
    return (await this.call('outbox_depth')) as number
  }

  drainedEvents(): string[] {
    const drained = this.events.slice()

    this.events.length = 0

    return drained
  }

  async seedCheckpoint(cursor: string): Promise<void> {
    await this.call('seed_checkpoint', { cursor })
  }

  seedLocalMutations(specs: TLocalMutationSpec[]): void {
    this.preconditions.clear()
    this.batchIds.clear()
    this.hlcs.clear()

    for (const spec of specs) {
      if (spec.precondition !== undefined) {
        this.preconditions.set(spec.mutationId, spec.precondition)
      }
      if (spec.batchId !== undefined) {
        this.batchIds.set(spec.mutationId, spec.batchId)
      }
      if (spec.hlc !== undefined) {
        this.hlcs.set(spec.mutationId, spec.hlc)
      }
    }
  }
}

// MARK: - Factory

/**
 * Build an `IProtocolClient` backed by a Rust engine opened through `factory`.
 * The caller keeps the transport the factory returned and closes it when the
 * case ends; the client itself has no lifecycle beyond the engine it drives.
 */
export const makeTransportClient = (options: ITransportClientOptions): IProtocolClient =>
  new TransportClient(options)
