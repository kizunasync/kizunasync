import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { ERpcKind, EWireEntryKind, type TRpcKind } from 'kizunasync'
import { SESSION_OWNER_PANE, type TPaneId } from '@/runtime/demo-config'
import type { IWireLog, TWireVerdict } from '@/runtime/wire-log'

// MARK: - Per-pane supabase-js client, with the wire tap installed

/**
 * Each pane gets its OWN supabase-js client: separate auth storage (so each pane
 * keeps its own client state across a reload) and a separate fetch wrapper
 * feeding the wire log with that pane's tag. The two clients share ONE identity:
 * the owner pane mints it and the follower adopts it (lib/session.ts).
 *
 * createSupabaseKizunaSync builds its IProtocolRemote internally (createRpcRemote)
 * and neither returns it nor accepts an override, so the remote cannot be
 * wrapped without editing kizunasync/supabase. The next layer that sees the same
 * traffic is supabase-js's injectable `fetch`, which measures the real
 * serialized bytes, not a re-stringified guess.
 */
const AUTH_STORAGE_PREFIX = 'kizunasync-demo-pane'

interface ICreatePaneClientOptions {
  pane: TPaneId
  wireLog: IWireLog
}

export const createPaneSupabaseClient = (options: ICreatePaneClientOptions): SupabaseClient => {
  const { pane, wireLog } = options

  return createClient(import.meta.env.VITE_DEMO_SUPABASE_URL, import.meta.env.VITE_DEMO_SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      // One storage slot per pane: the panes share an identity but not a client, and a shared slot would have them overwrite each other's state.
      storageKey: `${AUTH_STORAGE_PREFIX}-${pane.toLowerCase()}`,
      persistSession: true,
      // Exactly one refresher per identity. Two clients rotating the same refresh token would race, and the loser would hold a revoked one.
      autoRefreshToken: pane === SESSION_OWNER_PANE,
    },
    global: { fetch: tapFetch(pane, wireLog) },
  })
}

/**
 * A plain unwrapped client for staging work that must NOT appear on either
 * pane's wire (the foreign-row setup signs in as a third identity).
 */
export const createPlainSupabaseClient = (storageSuffix: string): SupabaseClient =>
  createClient(import.meta.env.VITE_DEMO_SUPABASE_URL, import.meta.env.VITE_DEMO_SUPABASE_PUBLISHABLE_KEY, {
    auth: { storageKey: `${AUTH_STORAGE_PREFIX}-${storageSuffix}`, persistSession: false },
  })

// MARK: - internal

type TFetch = typeof globalThis.fetch

/**
 * Wraps fetch so every kizunasync.pull / kizunasync.push round trip lands in the
 * wire log with its real byte sizes, then lifts each per-mutation verdict out of
 * a push response into its own entry. Non-RPC traffic (auth, realtime) passes
 * through untouched.
 */
function tapFetch(pane: TPaneId, wireLog: IWireLog): TFetch {
  return async (input, init) => {
    const rpc = rpcNameOf(input)

    if (rpc === null) {
      return fetch(input, init)
    }
    const bytesOut = byteLengthOf(init?.body)
    const startedAt = performance.now()
    // The response body is read once here and handed back as a fresh Response: consuming the original stream would leave supabase-js nothing to parse.
    let response: Response

    try {
      response = await fetch(input, init)
    } catch (cause) {
      wireLog.record(pane, {
        kind: EWireEntryKind.rpc,
        call: { rpc, bytesOut, bytesIn: 0, durationMs: performance.now() - startedAt, ok: false },
      })

      throw cause
    }
    const text = await response.clone().text()

    wireLog.record(pane, {
      kind: EWireEntryKind.rpc,
      call: {
        rpc,
        bytesOut,
        bytesIn: new TextEncoder().encode(text).length,
        durationMs: performance.now() - startedAt,
        ok: response.ok,
      },
    })

    if (rpc === ERpcKind.push) {
      for (const verdict of readVerdicts(text)) {
        wireLog.record(pane, { kind: EWireEntryKind.verdict, verdict })
      }
    }
    return response
  }
}

/**
 * The RPC name if this request is a kizunasync pull/push, else null. The SQL
 * pack exposes them as POST /rest/v1/rpc/pull under the `kizunasync` schema, so
 * the path tail is the discriminator.
 */
function rpcNameOf(input: RequestInfo | URL): TRpcKind | null {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

  if (url.includes('/rpc/pull')) {
    return ERpcKind.pull
  }
  if (url.includes('/rpc/push')) {
    return ERpcKind.push
  }
  return null
}

function byteLengthOf(body: BodyInit | null | undefined): number {
  if (typeof body === 'string') {
    return new TextEncoder().encode(body).length
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength
  }
  if (ArrayBuffer.isView(body)) {
    return body.byteLength
  }
  return 0
}

/**
 * Lifts `{ verdicts: [{ mutation_id, verdict, reason }] }` out of a push
 * response body. A body that does not parse or does not carry verdicts yields
 * none: the viewer shows less; it must not throw inside a fetch the engine is
 * awaiting.
 */
function readVerdicts(body: string): TWireVerdict[] {
  let parsed: unknown

  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  const verdicts = (parsed as { verdicts?: unknown }).verdicts

  if (!Array.isArray(verdicts)) {
    return []
  }
  const out: TWireVerdict[] = []

  for (const raw of verdicts) {
    const record = raw as { mutation_id?: unknown; verdict?: unknown; reason?: unknown }

    if (typeof record.mutation_id !== 'string') {
      continue
    }
    out.push({
      mutationId: record.mutation_id,
      applied: record.verdict === 'applied',
      reason: typeof record.reason === 'string' ? record.reason : null,
    })
  }
  return out
}
