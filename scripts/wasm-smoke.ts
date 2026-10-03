/**
 * Instantiate the built browser engine outside a browser and prove it answers.
 *
 * Usage (repository root, after `bun run cargo:wasm`):
 *   bun run wasm:smoke
 *
 * The module runs on the in-memory SQLite VFS, the backend that needs no
 * browser storage. That exercises the wasm-bindgen glue, the engine, and the
 * envelope contract. The two remote callbacks reject on purpose: `ping` never
 * reaches them, and a smoke that silently synced would be testing the network
 * instead.
 *
 * Bun has neither OPFS nor IndexedDB. A named database is where the fail-loud
 * path is proved: it must reject, never fall back to memory.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type TRemoteCallback = (requestJson: string) => Promise<string>
type TEventCallback = (eventJson: string) => void

type TWasmEngine = {
  create: (configJson: string, pull: TRemoteCallback, push: TRemoteCallback) => Promise<void>
  call: (method: string, params: string) => Promise<string>
  subscribe: (callback: TEventCallback) => number
  unsubscribe: (id: number) => void
  free: () => void
}

type TGlue = {
  default: (init: { module_or_path: BufferSource }) => Promise<unknown>
  KizunaSyncWasmEngine: new () => TWasmEngine
}

const root = resolve(import.meta.dir, '..')
const wasmDir = resolve(root, 'packages/web/src/wasm')
const binary = resolve(wasmDir, 'kizunasync_wasm_bg.wasm')

if (!existsSync(binary)) {
  console.error(`[wasm-smoke] ${binary} is missing. Run: bun run cargo:wasm`)
  process.exit(1)
}

const MEMORY_CONFIG = JSON.stringify({
  client_id: crypto.randomUUID(),
  tables: { items: { bucket_column: 'user_id', bucket_params: { user_id: 'u1' } } },
  database_path: ':memory:',
})

const NAMED_CONFIG = JSON.stringify({
  client_id: crypto.randomUUID(),
  tables: { items: { bucket_column: 'user_id', bucket_params: { user_id: 'u1' } } },
  database_path: 'kizunasync-smoke.db',
})

const PONG = '{"ok":true,"value":"pong"}'
const ONE_PENDING = '{"ok":true,"value":1}'
const NONE_PENDING = '{"ok":true,"value":0}'

const failures: string[] = []

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)

  console.log(`[wasm-smoke] ${ok ? 'ok  ' : 'FAIL'} ${label}`)

  if (!ok) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function rejecting(name: string): TRemoteCallback {
  return () => Promise.reject(new Error(`${name} must not be called by this smoke`))
}

type TEnvelope = { ok?: boolean; error?: { code?: string; kind?: string; message?: string } }

function envelope(raw: string): TEnvelope {
  return JSON.parse(raw) as TEnvelope
}

const glue: TGlue = await import(resolve(wasmDir, 'kizunasync_wasm.js'))

await glue.default({ module_or_path: readFileSync(binary) })

const engine = new glue.KizunaSyncWasmEngine()

/**
 * Before `create` there is no engine to take the call, and the page must be
 * able to tell that apart from a method failure by its code alone.
 */
const beforeCreate = envelope(await engine.call('ping', '{}'))

check('call before create is not ok', beforeCreate.ok, false)
check('call before create carries ENGINE_UNAVAILABLE', beforeCreate.error?.code, 'ENGINE_UNAVAILABLE')
check('call before create is kind engine_unavailable', beforeCreate.error?.kind, 'engine_unavailable')

/**
 * No OPFS and no IndexedDB under Bun, so a named database has nowhere durable
 * to live. It must reject; it must not quietly open a memory database the
 * page would believe was persistent.
 */
const named = new glue.KizunaSyncWasmEngine()
let namedRejection = ''

try {
  await named.create(NAMED_CONFIG, rejecting('pull'), rejecting('push'))
} catch (error: unknown) {
  namedRejection = String(error)
}
check(
  'a named database fails loud where none can persist',
  namedRejection.includes('no persistent VFS available'),
  true,
)

await engine.create(MEMORY_CONFIG, rejecting('pull'), rejecting('push'))

check('ping answers pong', await engine.call('ping', '{}'), PONG)

/**
 * A local write is the shortest path to an engine event, and the fan-out from
 * the engine's single listener to the page's subscribers has no other cover.
 */
const events: string[] = []
const subscription = engine.subscribe((payload: string) => events.push(payload))

check('the first subscription id is 1', subscription, 1)

const applied = envelope(
  await engine.call(
    'apply',
    JSON.stringify({
      table: 'items',
      pk: 'p-1',
      op: 'insert',
      columns: { title: 'works on a plane', user_id: 'u1' },
    }),
  ),
)

check('apply is ok', applied.ok, true)
check(
  'the subscriber saw LOCAL_CHANGED',
  events.map((payload) => (JSON.parse(payload) as { type: string }).type).includes('LOCAL_CHANGED'),
  true,
)

engine.unsubscribe(subscription)
const seen = events.length

await engine.call(
  'apply',
  JSON.stringify({ table: 'items', pk: 'p-2', op: 'insert', columns: { user_id: 'u1' } }),
)
check('unsubscribe stops the stream', events.length, seen)

/**
 * A create that arrives while a network call is held builds a second engine
 * and swaps it in only once it is ready. Calls made after the swap reach the
 * second engine, while the held call finishes on the one it started on. A
 * local call answers without waiting for the remote.
 */
let releaseHeld: () => void = () => {}
const heldGate = new Promise<void>((settle) => {
  releaseHeld = settle
})

let heldPullEntered = false

const busy = new glue.KizunaSyncWasmEngine()

await busy.create(
  MEMORY_CONFIG,
  async () => {
    heldPullEntered = true
    await heldGate

    return JSON.stringify({ ok: false, message: 'gate released', retryable: false })
  },
  rejecting('push'),
)
await busy.call(
  'apply',
  JSON.stringify({ table: 'items', pk: 'p-held', op: 'insert', columns: { user_id: 'u1' } }),
)
const holding = busy.call('pull_once', '{}')

await Promise.resolve()
check('the held call reached the remote before the create', heldPullEntered, true)
check(
  'a local call answers while the network call is held',
  await busy.call('outbox_depth', '{}'),
  ONE_PENDING,
)

let replacementRejection = ''

try {
  await busy.create(MEMORY_CONFIG, rejecting('pull'), rejecting('push'))
} catch (error: unknown) {
  replacementRejection = String(error)
}
check('a create resolves while the network call is held', replacementRejection, '')
/**
 * The first engine holds one pending insert and the second opened an empty
 * memory database, so the outbox depth names the engine that answered.
 */
check('a later call runs on the second engine', await busy.call('outbox_depth', '{}'), NONE_PENDING)
releaseHeld()
const held = envelope(await holding)

check('the held call still answers once released', held.ok, false)
/**
 * The second engine's pull rejects with its own sentence, so the held call
 * carries the first remote's message only if it stayed on the engine it
 * started on.
 */
check(
  'the held call answers from the engine it started on',
  held.error?.message?.includes('gate released'),
  true,
)
busy.free()

/**
 * The page may drop its last reference to an engine while a call is running,
 * and the finalizer frees the wrapper. The in-flight future has to own what it
 * reads, or it resumes against freed memory and traps the whole instance.
 *
 * The call is parked on a pending JS promise before the free, which is the
 * ordering the original fault needed: the future is suspended mid-await, so it
 * resumes only after the wrapper is gone.
 */
let releasePull: () => void = () => {}
const gate = new Promise<void>((settle) => {
  releasePull = settle
})

let pullEntered = false

function gatedPull(): TRemoteCallback {
  return async () => {
    pullEntered = true
    await gate

    return JSON.stringify({ ok: false, message: 'gate released', retryable: false })
  }
}

const disposable = new glue.KizunaSyncWasmEngine()

await disposable.create(MEMORY_CONFIG, gatedPull(), rejecting('push'))
const parked = disposable.call('pull_once', '{}')

await Promise.resolve()
check('the call is parked on the remote before the free', pullEntered, true)
disposable.free()
releasePull()
const settled = envelope(await parked)

check('a call parked on JS survives free() mid-flight', settled.ok, false)
check('the instance still works after that free', await engine.call('ping', '{}'), PONG)

if (failures.length > 0) {
  console.error(`[wasm-smoke] ${failures.length} failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('[wasm-smoke] all checks passed')
