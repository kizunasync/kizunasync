/* tslint:disable */
/* eslint-disable */

/**
 * One live engine: one database, one remote, one event stream.
 */
export class KizunaSyncWasmEngine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Run one engine method and resolve with its envelope. Never rejects: a
     * method failure and a missing engine are both `ok:false`.
     *
     * `params` may carry the embedder's clock (`now` / `now_ms`); the dispatch
     * pins it, so the browser stamps rows, outbox entries and the rejection
     * journal with the value the page sent.
     *
     * The call takes its own reference to the engine when it is made, so
     * `free()` or a garbage collection of the wrapper while it is in flight
     * drops one reference instead of the engine the call is still using.
     * Nothing is borrowed across the await: a local call answers while a
     * network call awaits the remote, and the engine runs the calls that pull
     * or push one at a time.
     */
    call(method: string, params: string): Promise<string>;
    /**
     * Open the engine described by `config_json`, with `pull` and `push` as the
     * page's transport. Resolves with `undefined`, and rejects when the
     * configuration or the store is refused: the page asked for the Rust
     * engine, so a store it cannot open is fatal rather than a silent
     * downgrade to memory.
     *
     * Every refusal rejects with the same failure envelope [`Self::call`]
     * answers with, so the page reads a machine-readable code instead of
     * classifying an opaque sentence: `CONFIG_INVALID` for a config it must
     * respell, and the store's own code for a database that will not open
     * (`STORE_BUSY` for a pool another context holds, `STORE_UNAVAILABLE` where
     * no persistent VFS can be installed).
     *
     * The future owns its own handles to the engine cell, so a page that drops
     * or frees the wrapper while this runs cannot leave it reading freed
     * memory. The cell changes only once the engine is built: until then a
     * call runs on the engine the handle already had, or answers
     * `ENGINE_UNAVAILABLE` when there is none, and never sees a half-built
     * one. Calls already running when it changes finish on the engine they
     * started on.
     */
    create(config_json: string, pull: Function, push: Function): Promise<void>;
    /**
     * A handle with no engine yet. Call [`Self::create`] before anything else.
     */
    constructor();
    /**
     * Receive engine events as JSON. The returned id is what `unsubscribe`
     * takes; ids start at 1 and are never reused. `0` means no subscription was
     * made, which happens only if the observer list is busy or its ids are
     * exhausted.
     */
    subscribe(callback: Function): number;
    /**
     * Stop the subscription `id` names. Unknown ids are a no-op.
     */
    unsubscribe(id: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_kizunasyncwasmengine_free: (a: number, b: number) => void;
    readonly kizunasyncwasmengine_call: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly kizunasyncwasmengine_create: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly kizunasyncwasmengine_new: () => number;
    readonly kizunasyncwasmengine_subscribe: (a: number, b: number) => number;
    readonly kizunasyncwasmengine_unsubscribe: (a: number, b: number) => void;
    readonly rust_sqlite_wasm_abort: () => void;
    readonly rust_sqlite_wasm_assert_fail: (a: number, b: number, c: number, d: number) => void;
    readonly rust_sqlite_wasm_calloc: (a: number, b: number) => number;
    readonly rust_sqlite_wasm_free: (a: number) => void;
    readonly rust_sqlite_wasm_getentropy: (a: number, b: number) => number;
    readonly rust_sqlite_wasm_localtime: (a: number) => number;
    readonly rust_sqlite_wasm_malloc: (a: number) => number;
    readonly rust_sqlite_wasm_realloc: (a: number, b: number) => number;
    readonly sqlite3_os_end: () => number;
    readonly sqlite3_os_init: () => number;
    readonly __wasm_bindgen_func_elem_4759: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_4783: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_737: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_2458: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_2460: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export5: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
