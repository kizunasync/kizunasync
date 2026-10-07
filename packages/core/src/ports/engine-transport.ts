// MARK: - EngineTransport port

/**
 * The NAPI addon and the UniFFI handle are both loaded by the core. A driver
 * that already owns an engine (the browser worker running `kizunasync-wasm`,
 * where the page cannot dlopen anything) hands that engine over on the
 * locator it was going to pass to `createKizunaSync`.
 *
 * Call surface matches the addon: `(method, paramsJson)` in, one response
 * envelope out. Failure layers stay distinct. An engine failure is data
 * inside that envelope, so the adapter's error mapping is identical on every
 * backend. A transport that cannot reach its engine rejects with
 * `ENGINE_UNAVAILABLE` (there is no envelope to carry).
 *
 * A locator that carries a transport is asking for the Rust engine. The
 * transport is the only way its rows can be read, so `selectEngine` builds
 * on it and nothing else (@../../../../CONVENTIONS.md).
 */
export interface IEngineTransport {
  /** Run one engine method; resolves the JSON response envelope. */
  call(method: string, paramsJson: string): Promise<string>

  /**
   * Stop the engine and release what it holds (idempotent). A backend whose
   * release is asynchronous returns the promise that settles once it is done:
   * the NAPI addon resolves once its engine thread is gone and SQLite has let
   * the database file go, so the caller may reopen that file. A backend that
   * releases immediately returns `void`.
   */
  close(): void | Promise<void>

  /**
   * Present on a transport that shares its engine with other hosts (the browser
   * worker driver's tabs), where only the leading one drives the automatic sync
   * loop. A transport without it is always its engine's leader.
   */
  readonly leadership?: IEngineLeadership
}

/**
 * Whether this host leads the engine it reaches. A follower's calls still run,
 * on the leader's engine; only the automatic loop waits for a promotion.
 */
export interface IEngineLeadership {
  isLeader(): boolean

  /** Called with the new answer on every change; returns the unsubscribe function. */
  subscribe(onChange: (leader: boolean) => void): () => void
}

/* eslint-disable max-params -- mirrors the N-API engine constructor argument for argument */
/**
 * Opens one engine. Mirrors `TNapiEngineConstructor` argument for argument:
 * a transport and the addon constructor are interchangeable at the one call
 * site that builds a native handle. `databasePath` is `null` for a private
 * in-memory store. `pull` and `push` never reject (a transport failure is an
 * envelope). `onEvent` receives the engine's tagged event JSON.
 */
export type TEngineTransportFactory = (
  configJson: string,
  databasePath: string | null,
  pull: (requestJson: string) => Promise<string>,
  push: (requestJson: string) => Promise<string>,
  onEvent: (eventJson: string) => void,
) => IEngineTransport
/* eslint-enable max-params */
