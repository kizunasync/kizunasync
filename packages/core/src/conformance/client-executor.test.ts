/// <reference types="bun" />
// MARK: - Client conformance suite

/**
 * Manifest-driven exactly like packages/protocol/executor/conformance.test.ts:
 * every executing case replays against the REAL engine: the Rust core behind
 * the NAPI addon, driven through `makeTransportClient` over the
 * `IEngineTransport` port, which is the same seam the browser worker speaks.
 * Cases run under the visibility horizon (D-visibility-horizon decided; the client is
 * fencing-agnostic at the wire level: it consumes responses). Blocked entries
 * skip visibly with their OD gate named (identical to conformance.test.ts).
 *
 * Skipped wholesale when the addon is not built (`cargo build -p kizunasync-napi`):
 * without it there is no engine to run the corpus against at all.
 *
 *   ASSERTING (all non-blocked families, one run each under the visibility
 *   horizon):
 *     pull/001, pull/002, tombstones/001-002, lifecycle/001-003 (003 = push-side
 *     schema handshake: a stale-schema push returns RESET_REQUIRED, the engine
 *     soft-blocks and leaves the outbox untouched, D-schema-version-handshake),
 *     fencing/001, fencing/002, wakeup/001,
 *     conflict/001-002, conflict/003 (hlc origin-order: the engine attaches the
 *     fed origin HLC for the hlc-mode todos table, reverts the SUPERSEDED
 *     mutation to the hlc-winning server_row, emits MUTATION_REJECTED),
 *     push/001-005 (003 = the dropped push acknowledgement:
 *     the request is asserted, the ack is lost, and the next push step replays
 *     the identical bytes; 005 = atomic batch revert: the engine builds the
 *     atomic push, reverts on abort, emits BATCH_ABORTED, D-atomic-batch-abort)
 *   SKIPPED (one, named in its own skip message):
 *     wakeup/002, which is blocked on D-wakeup-channel with zero wire bytes pinned.
 */

import { describe, expect, test } from 'bun:test'
import { readCorpusFile } from '@kizunasync/protocol/harness/load'
import { EFencing } from '@kizunasync/protocol/executor/server-contract'
import type { TFencing } from '@kizunasync/protocol/executor/server-contract'
import { loadNapiAddon, type INapiAddon } from '../query/napi-loader'
import type { IEngineTransport, TEngineTransportFactory } from '../ports/engine-transport'
import { resolveCorpusRoot } from './corpus-path'
import { configFromContext, runTranscriptClient } from './client-executor'
import { TranscriptRemote } from './transcript-remote'
import { makeTransportClient } from './transport-client'

const addon = loadNapiAddon()
const hasAddon = addon !== null

// MARK: - Manifest iteration

const ROOT = resolveCorpusRoot()

type TJsonObject = Record<string, unknown>

const asObject = (value: unknown): TJsonObject | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as TJsonObject) : null

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const strings = (value: unknown): string[] =>
  asArray(value).filter((item): item is string => typeof item === 'string')

const manifest = asObject(readCorpusFile(ROOT, 'cases/manifest.json').json)

// MARK: - The transport under test

type TOpenedTransport = { factory: TEngineTransportFactory; close: () => void }

/**
 * `INapiEngine.call` may answer synchronously (a loaded backend is allowed to),
 * so the addon handle is adapted to the port's always-async `call` here. The
 * engine is remembered so the case can close it, which stops its engine thread.
 */
const napiTransport = (bridge: INapiAddon): TOpenedTransport => {
  let opened: IEngineTransport | null = null

  return {
    factory: (configJson, databasePath, pull, push, onEvent): IEngineTransport => {
      const engine = new bridge.KizunaSyncEngine(configJson, databasePath, pull, push, onEvent)
      const transport: IEngineTransport = {
        call: async (method, paramsJson) => engine.call(method, paramsJson),
        close: () => {
          engine.close()
        },
      }

      opened = transport

      return transport
    },
    close: () => {
      opened?.close()
    },
  }
}

// MARK: - One asserting test

const clientTest = (name: string, file: string, candidate: TFencing): void => {
  test(name, async () => {
    if (addon === null) {
      throw new Error('the native addon is required for this suite')
    }
    const transcript = readCorpusFile(ROOT, file).json
    const context = asObject(asObject(transcript)?.context) ?? {}
    const config = configFromContext(asObject(transcript) ?? {})
    const transport = napiTransport(addon)

    try {
      const client = makeTransportClient({
        factory: transport.factory,
        config,
        // The identity the Rust executor opens its engine with (`context.client_id`).
        clientId: typeof context.client_id === 'string' ? context.client_id : '',
        databasePath: null,
        remote: new TranscriptRemote(),
      })
      const result = await runTranscriptClient(client, transcript, candidate)

      if (result.status === 'fail') {
        // Surface the diverging checks/bytes in the assertion output.
        expect(result.failures).toEqual([])
      }
      expect(result.status).toBe('pass')
    } finally {
      transport.close()
    }
  })
}

// MARK: - Suite

describe.skipIf(!hasAddon)('client conformance: golden transcripts × the Rust engine (NAPI)', () => {
  for (const raw of asArray(manifest?.cases)) {
    const entry = asObject(raw)

    if (entry === null) {
      continue
    }
    const id = typeof entry.id === 'string' ? entry.id : ''

    // Blocked (zero seed bytes): a visible skip naming the OD gate, identical to the server suite (D-schema-version-handshake lifecycle/003, D-wakeup-channel wakeup/002).
    if (entry.file === null) {
      const gates = strings(entry.blocked_on).join(', ')
      const notes = strings(entry.notes).join(' · ')

      test.skip(`${id}: blocked on ${gates} (${notes})`, () => {})
      continue
    }

    if (typeof entry.file === 'string') {
      clientTest(id, entry.file, EFencing.visibilityHorizon)
    }
  }
})

// MARK: - Config from the transcript context

describe('configFromContext', () => {
  test('a table key reaches the engine config as the transcript declares it, and only when it is not id', () => {
    const config = configFromContext({
      context: {
        user_id: 'u1',
        server: {
          tables: {
            seats: { bucket_column: 'owner_id', key_columns: ['hall', 'seat'] },
            notices: { bucket_column: 'owner_id', key_columns: ['id'] },
            todos: { bucket_column: 'owner_id' },
          },
        },
      },
    })

    expect(config.tables.seats?.key).toEqual(['hall', 'seat'])
    expect(config.tables.notices?.key).toBeUndefined()
    expect(config.tables.todos?.key).toBeUndefined()
  })
})
