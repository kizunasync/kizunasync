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
    readonly turso_statement_row_value_int: (a: number, b: number) => bigint;
    readonly turso_statement_row_value_double: (a: number, b: number) => number;
    readonly turso_connection_close: (a: number, b: number) => number;
    readonly turso_connection_deinit: (a: number) => void;
    readonly turso_connection_enable_load_extension: (a: number, b: number, c: number) => number;
    readonly turso_connection_get_autocommit: (a: number) => number;
    readonly turso_connection_last_insert_rowid: (a: number) => bigint;
    readonly turso_connection_prepare_first: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly turso_connection_prepare_single: (a: number, b: number, c: number, d: number) => number;
    readonly turso_connection_register_aggregate_function: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => number;
    readonly turso_connection_register_collation: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly turso_connection_register_scalar_function: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly turso_connection_set_busy_timeout_ms: (a: number, b: bigint) => void;
    readonly turso_connection_unregister_collation: (a: number, b: number, c: number) => number;
    readonly turso_connection_unregister_function: (a: number, b: number, c: number) => number;
    readonly turso_database_connect: (a: number, b: number, c: number) => number;
    readonly turso_database_deinit: (a: number) => void;
    readonly turso_database_new: (a: number, b: number, c: number) => number;
    readonly turso_database_open: (a: number, b: number) => number;
    readonly turso_setup: (a: number, b: number) => number;
    readonly turso_statement_bind_positional_blob: (a: number, b: number, c: number, d: number) => number;
    readonly turso_statement_bind_positional_double: (a: number, b: number, c: number) => number;
    readonly turso_statement_bind_positional_int: (a: number, b: number, c: bigint) => number;
    readonly turso_statement_bind_positional_null: (a: number, b: number) => number;
    readonly turso_statement_bind_positional_text: (a: number, b: number, c: number, d: number) => number;
    readonly turso_statement_column_array_dimensions: (a: number, b: number) => number;
    readonly turso_statement_column_base_type: (a: number, b: number) => number;
    readonly turso_statement_column_count: (a: number) => bigint;
    readonly turso_statement_column_declared_name: (a: number, b: number) => number;
    readonly turso_statement_column_decltype: (a: number, b: number) => number;
    readonly turso_statement_column_kind: (a: number, b: number) => number;
    readonly turso_statement_column_name: (a: number, b: number) => number;
    readonly turso_statement_deinit: (a: number) => void;
    readonly turso_statement_execute: (a: number, b: number, c: number) => number;
    readonly turso_statement_finalize: (a: number, b: number) => number;
    readonly turso_statement_n_change: (a: number) => bigint;
    readonly turso_statement_named_position: (a: number, b: number) => bigint;
    readonly turso_statement_parameter_name: (a: number, b: bigint) => number;
    readonly turso_statement_parameters_count: (a: number) => bigint;
    readonly turso_statement_reset: (a: number, b: number) => number;
    readonly turso_statement_row_value_bytes_count: (a: number, b: number) => bigint;
    readonly turso_statement_row_value_bytes_ptr: (a: number, b: number) => number;
    readonly turso_statement_row_value_kind: (a: number, b: number) => number;
    readonly turso_statement_run_io: (a: number, b: number) => number;
    readonly turso_statement_step: (a: number, b: number) => number;
    readonly turso_str_deinit: (a: number) => void;
    readonly turso_version: () => number;
    readonly Median_finalize: (a: number, b: number, c: number) => void;
    readonly Median_init: (a: number) => number;
    readonly Median_step: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly PercentileCont_finalize: (a: number, b: number, c: number) => void;
    readonly PercentileCont_init: (a: number) => number;
    readonly PercentileCont_step: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly PercentileDisc_finalize: (a: number, b: number, c: number) => void;
    readonly PercentileDisc_step: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly Percentile_finalize: (a: number, b: number, c: number) => void;
    readonly Percentile_step: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly StandardDeviation_finalize: (a: number, b: number, c: number) => void;
    readonly StandardDeviation_init: (a: number) => number;
    readonly StandardDeviation_step: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly uuid4_str: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly uuid4_blob: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly uuid7_str: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly uuid7: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly uuid7_ts: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly uuid_str: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly uuid_blob: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly rename_GenerateSeriesVTabModule: (a: number, b: number) => number;
    readonly begin_GenerateSeriesVTabModule: (a: number) => number;
    readonly best_idx_GenerateSeriesVTabModule: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly rowid_GenerateSeriesVTabModule: (a: number) => bigint;
    readonly update_GenerateSeriesVTabModule: (a: number, b: number, c: number, d: number) => number;
    readonly eof_GenerateSeriesVTabModule: (a: number) => number;
    readonly next_GenerateSeriesVTabModule: (a: number) => number;
    readonly column_GenerateSeriesVTabModule: (a: number, b: number, c: number) => void;
    readonly filter_GenerateSeriesVTabModule: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly close_GenerateSeriesVTabModule: (a: number) => number;
    readonly open_GenerateSeriesVTabModule: (a: number, b: number) => number;
    readonly create_GenerateSeriesVTabModule: (a: number, b: number, c: number) => void;
    readonly time_now: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_date: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly make_date: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly make_timestamp: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_get: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_get_year: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_get_month: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_get_day: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_get_hour: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_get_minute: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_get_second: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_get_nano: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_get_weekday: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_get_yearday: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_get_isoyear: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_get_isoweek: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_unix: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly to_timestamp: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_milli: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_micro: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_nano: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_to_unix: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_to_milli: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_to_micro: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_to_nano: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_after: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_before: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_compare: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_equal: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly dur_ns: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly dur_us: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly dur_ms: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly dur_s: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly dur_m: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly dur_h: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_add: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_add_date: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_sub: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_since: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_until: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_trunc: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_round: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_fmt_iso: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_fmt_datetime: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_fmt_date: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_fmt_time: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly time_parse: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly regexp: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly register_GenerateSeriesVTabModule: (a: number) => number;
    readonly register_Median: (a: number) => number;
    readonly register_Percentile: (a: number) => number;
    readonly register_PercentileCont: (a: number) => number;
    readonly register_PercentileDisc: (a: number) => number;
    readonly register_StandardDeviation: (a: number) => number;
    readonly register_dur_h: (a: number) => number;
    readonly register_dur_m: (a: number) => number;
    readonly register_dur_ms: (a: number) => number;
    readonly register_dur_ns: (a: number) => number;
    readonly register_dur_s: (a: number) => number;
    readonly register_dur_us: (a: number) => number;
    readonly register_make_date: (a: number) => number;
    readonly register_make_timestamp: (a: number) => number;
    readonly register_regexp: (a: number) => number;
    readonly register_time_add: (a: number) => number;
    readonly register_time_add_date: (a: number) => number;
    readonly register_time_after: (a: number) => number;
    readonly register_time_before: (a: number) => number;
    readonly register_time_compare: (a: number) => number;
    readonly register_time_date: (a: number) => number;
    readonly register_time_equal: (a: number) => number;
    readonly register_time_fmt_date: (a: number) => number;
    readonly register_time_fmt_datetime: (a: number) => number;
    readonly register_time_fmt_iso: (a: number) => number;
    readonly register_time_fmt_time: (a: number) => number;
    readonly register_time_get: (a: number) => number;
    readonly register_time_get_day: (a: number) => number;
    readonly register_time_get_hour: (a: number) => number;
    readonly register_time_get_isoweek: (a: number) => number;
    readonly register_time_get_isoyear: (a: number) => number;
    readonly register_time_get_minute: (a: number) => number;
    readonly register_time_get_month: (a: number) => number;
    readonly register_time_get_nano: (a: number) => number;
    readonly register_time_get_second: (a: number) => number;
    readonly register_time_get_weekday: (a: number) => number;
    readonly register_time_get_year: (a: number) => number;
    readonly register_time_get_yearday: (a: number) => number;
    readonly register_time_micro: (a: number) => number;
    readonly register_time_milli: (a: number) => number;
    readonly register_time_nano: (a: number) => number;
    readonly register_time_now: (a: number) => number;
    readonly register_time_parse: (a: number) => number;
    readonly register_time_round: (a: number) => number;
    readonly register_time_since: (a: number) => number;
    readonly register_time_sub: (a: number) => number;
    readonly register_time_to_micro: (a: number) => number;
    readonly register_time_to_milli: (a: number) => number;
    readonly register_time_to_nano: (a: number) => number;
    readonly register_time_to_unix: (a: number) => number;
    readonly register_time_trunc: (a: number) => number;
    readonly register_time_unix: (a: number) => number;
    readonly register_time_until: (a: number) => number;
    readonly register_to_timestamp: (a: number) => number;
    readonly register_uuid4_blob: (a: number) => number;
    readonly register_uuid4_str: (a: number) => number;
    readonly register_uuid7: (a: number) => number;
    readonly register_uuid7_str: (a: number) => number;
    readonly register_uuid7_ts: (a: number) => number;
    readonly register_uuid_blob: (a: number) => number;
    readonly register_uuid_str: (a: number) => number;
    readonly PercentileDisc_init: (a: number) => number;
    readonly Percentile_init: (a: number) => number;
    readonly commit_GenerateSeriesVTabModule: (a: number) => number;
    readonly destroy_GenerateSeriesVTabModule: (a: number) => number;
    readonly rollback_GenerateSeriesVTabModule: (a: number) => number;
    readonly __wasm_bindgen_func_elem_10122: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_10137: (a: number, b: number, c: number, d: number) => void;
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
