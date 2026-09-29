import Foundation
#if canImport(KizunaSyncFfi)
import KizunaSyncFfi
#endif

/// One attachment column: Storage bucket plus the owner column used to derive the object key.
public struct KizunaSyncAttachmentSpec: Equatable, Sendable {
  /// The Supabase Storage bucket the object lives in.
  public var storageBucket: String
  /// The row column whose value scopes the object key to one owner.
  public var ownerColumn: String

  /// Declare one attachment column.
  public init(storageBucket: String, ownerColumn: String) {
    self.storageBucket = storageBucket
    self.ownerColumn = ownerColumn
  }
}

/// Which rule resolves two writes to one column.
public enum KizunaSyncConflictMode: String, Sendable {
  /// Server arrival order decides, trusting no device clock.
  case arrival
  /// The origin clock decides: every mutation this device queues for such a
  /// table carries the stamp the server compares.
  case hlc
}

/// Which directions a table syncs in.
public enum KizunaSyncSyncMode: String, Sendable {
  /// The device pulls the table and pushes its local writes.
  case readWrite = "read-write"
  /// The server owns the table: the device pulls it, and the engine refuses
  /// every local write with `LOCAL_UNSUPPORTED`.
  case pullOnly = "pull-only"
}

/// Which rows of a table this device pulls.
public enum KizunaSyncBucket: Equatable, Sendable {
  /// Every row the server's RLS lets the signed-in user read.
  case none
  /**
   * The rows whose column holds the signed-in user's id. The engine takes that
   * id from the session, so the app never calls `setBucket` for this table,
   * and an insert that leaves the column out is written with it.
   */
  case byOwner(String)
  /// The rows whose column holds the value the app passes to `setBucket`.
  case byColumn(String)
}

/// Table declaration that encodes to the UniFFI `create` JSON.
public struct KizunaSyncTableConfig: Equatable, Sendable {
  /// Which rows of this table the device pulls.
  public var bucket: KizunaSyncBucket
  /// Attachment columns of this table, by column name.
  public var attachments: [String: KizunaSyncAttachmentSpec]
  /// The app-level deletion marker column. Set it and a filter-targeted
  /// `delete` becomes an update stamping this column, a low-level `apply` with
  /// op `delete` raises `SOFT_DELETE_VIOLATION`, and a marked row leaves every
  /// read until the plan asks for `includeDeleted`; nil leaves hard deletes
  /// legal.
  public var softDeleteColumn: String?
  /// Which rule resolves two writes to one of this table's columns.
  public var conflictMode: KizunaSyncConflictMode
  /// Which directions this table syncs in.
  public var syncMode: KizunaSyncSyncMode

  /// Declare one synced table.
  public init(
    bucket: KizunaSyncBucket = .none,
    attachments: [String: KizunaSyncAttachmentSpec] = [:],
    softDeleteColumn: String? = nil,
    conflictMode: KizunaSyncConflictMode = .arrival,
    syncMode: KizunaSyncSyncMode = .readWrite
  ) {
    self.bucket = bucket
    self.attachments = attachments
    self.softDeleteColumn = softDeleteColumn
    self.conflictMode = conflictMode
    self.syncMode = syncMode
  }
}

/// PostgREST remote. A present remote must have url + publishableKey; the engine
/// rejects null/incomplete objects instead of falling back to ScriptedRemote.
public struct KizunaSyncRemoteConfig: Equatable, Sendable {
  /// The Supabase project URL.
  public var url: String
  /// The project's publishable key.
  public var publishableKey: String
  /// The user's JWT, when one is already available at create time.
  public var accessToken: String?
  /// The Postgres schema the RPCs live in, when it is not the default.
  public var schema: String?
  /// Columns the client keeps out of every push payload.
  public var localOnlyColumns: [String]

  /// Declare the remote the engine syncs against.
  public init(
    url: String,
    publishableKey: String,
    accessToken: String? = nil,
    schema: String? = nil,
    localOnlyColumns: [String] = []
  ) {
    self.url = url
    self.publishableKey = publishableKey
    self.accessToken = accessToken
    self.schema = schema
    self.localOnlyColumns = localOnlyColumns
  }
}

/// Typed `create(config_json)` payload.
public struct KizunaSyncClientConfig: Equatable, Sendable {
  /**
   * Stable identifier of this device, carried on every pull and push. The
   * server's `kizunasync._clients.client_id` is a uuid column, so this is one
   * too: `KizunaSyncClient.create` refuses anything else with `CONFIG_INVALID`
   * rather than letting the server refuse it later. Passing none mints one.
   */
  public var clientId: String
  /// The schema generation the client expects from the server.
  public var schemaVersion: Int
  /// The synced tables, by table name.
  public var tables: [String: KizunaSyncTableConfig]
  /// The SQLite file. Absent, the engine opens an in-memory store.
  public var databasePath: String?
  /// The remote. The packaged library refuses an absent one with
  /// `CONFIG_INVALID`; only a host-test build without the `http` feature runs
  /// offline against a scripted remote.
  public var remote: KizunaSyncRemoteConfig?
  /// The directory attachment bytes are staged in. Required when a table declares attachments.
  public var attachmentRoot: String?
  /// How many rows one pull page asks for. Absent, the request omits `limit`
  /// and the server's own default applies.
  public var defaultLimit: Int?
  /// How many transfer attempts one attachment gets before the queue marks it
  /// permanently failed. Absent, the engine's own budget of five applies.
  public var attachmentAttempts: Int?

  /// Declare the client. `clientId` left nil mints a uuid for this device.
  public init(
    clientId: String? = nil,
    schemaVersion: Int = 1,
    tables: [String: KizunaSyncTableConfig],
    databasePath: String? = nil,
    remote: KizunaSyncRemoteConfig? = nil,
    attachmentRoot: String? = nil,
    defaultLimit: Int? = nil,
    attachmentAttempts: Int? = nil
  ) {
    self.clientId = clientId ?? UUID().uuidString.lowercased()
    self.schemaVersion = schemaVersion
    self.tables = tables
    self.databasePath = databasePath
    self.remote = remote
    self.attachmentRoot = attachmentRoot
    self.defaultLimit = defaultLimit
    self.attachmentAttempts = attachmentAttempts
  }

  /// Answers whether any table declares an attachment column.
  public var declaresAttachments: Bool {
    tables.values.contains { !$0.attachments.isEmpty }
  }

  /// The wire object the engine's `create` reads. A key the config left at the
  /// engine's own default stays out of the object, so this client and a
  /// JavaScript one built from the same declaration send the same bytes.
  public func jsonObject() -> [String: Any] {
    var object: [String: Any] = [
      "client_id": clientId,
      "schema_version": schemaVersion,
      "tables": tables.mapValues { table -> [String: Any] in
        var encoded: [String: Any] = [:]
        switch table.bucket {
        case .none:
          break
        case .byOwner(let column):
          encoded["bucket_column"] = column
          encoded["bucket_owner"] = true
        case .byColumn(let column):
          encoded["bucket_column"] = column
        }
        if !table.attachments.isEmpty {
          encoded["attachments"] = table.attachments.mapValues { spec in
            [
              "storage_bucket": spec.storageBucket,
              "owner_column": spec.ownerColumn,
            ]
          }
        }
        if let softDeleteColumn = table.softDeleteColumn {
          encoded["soft_delete_column"] = softDeleteColumn
        }
        if table.conflictMode == .hlc {
          encoded["conflict_mode"] = table.conflictMode.rawValue
        }
        if table.syncMode == .pullOnly {
          encoded["sync_mode"] = table.syncMode.rawValue
        }
        return encoded
      },
    ]
    if let defaultLimit {
      object["default_limit"] = defaultLimit
    }
    if let attachmentAttempts {
      object["attachment_attempts"] = attachmentAttempts
    }
    if let databasePath {
      object["database_path"] = databasePath
    }
    if let remote {
      var remoteObject: [String: Any] = [
        "url": remote.url,
        "publishable_key": remote.publishableKey,
      ]
      if let accessToken = remote.accessToken {
        remoteObject["access_token"] = accessToken
      }
      if let schema = remote.schema {
        remoteObject["schema"] = schema
      }
      if !remote.localOnlyColumns.isEmpty {
        remoteObject["local_only_columns"] = remote.localOnlyColumns
      }
      object["remote"] = remoteObject
    }
    if let attachmentRoot {
      object["attachment_root"] = attachmentRoot
    }
    return object
  }

  /// Whether `clientId` is the uuid `kizunasync._clients.client_id` stores.
  var carriesUuidClientId: Bool {
    UUID(uuidString: clientId) != nil
  }

  /// The wire object as the JSON string `create` takes.
  ///
  /// Throws `CONFIG_INVALID` when the encoded object is not UTF-8.
  public func jsonString() throws -> String {
    let data = try JSONSerialization.data(withJSONObject: jsonObject(), options: [])
    guard let string = String(data: data, encoding: .utf8) else {
      throw KizunaSyncError.engine(code: KizunaSyncErrorCode.configInvalid, message: "config is not utf8")
    }
    return string
  }
}

/// The three write operations a mutation carries.
public enum KizunaSyncOp: String, Sendable {
  /// Create the row.
  case insert
  /// Merge the given columns into the row.
  case update
  /// Tombstone the row.
  case delete
}

/// The three parse modes `textSearch` accepts. The engine refuses any other
/// value with `LOCAL_UNSUPPORTED`, so the type closes the set at the call site.
public enum KizunaSyncTextSearchType: String, Sendable {
  /// Every term has to appear, in any order.
  case plain
  /// The terms have to appear adjacent and in order.
  case phrase
  /// Every quoted phrase and every other word has to appear. A leading minus
  /// stays part of its word and excludes nothing.
  case websearch
}

/// Query-plan helpers. They serialize the local AST; they are not a second query engine.
public enum KizunaSyncQuery {
  /// Equality against `value`.
  public static func eq(_ column: String, _ value: Any) -> [String: Any] {
    ["kind": "eq", "column": column, "value": value]
  }

  /// Inequality against `value`.
  public static func neq(_ column: String, _ value: Any) -> [String: Any] {
    ["kind": "neq", "column": column, "value": value]
  }

  /// Greater than `value`.
  public static func gt(_ column: String, _ value: Any) -> [String: Any] {
    ["kind": "gt", "column": column, "value": value]
  }

  /// Greater than or equal to `value`.
  public static func gte(_ column: String, _ value: Any) -> [String: Any] {
    ["kind": "gte", "column": column, "value": value]
  }

  /// Less than `value`.
  public static func lt(_ column: String, _ value: Any) -> [String: Any] {
    ["kind": "lt", "column": column, "value": value]
  }

  /// Less than or equal to `value`.
  public static func lte(_ column: String, _ value: Any) -> [String: Any] {
    ["kind": "lte", "column": column, "value": value]
  }

  /// Case-sensitive pattern match, `%` and `_` as in SQL.
  public static func like(_ column: String, _ pattern: String) -> [String: Any] {
    ["kind": "like", "column": column, "pattern": pattern]
  }

  /// Case-insensitive pattern match, `%` and `_` as in SQL.
  public static func ilike(_ column: String, _ pattern: String) -> [String: Any] {
    ["kind": "ilike", "column": column, "pattern": pattern]
  }

  /// Identity test. The engine accepts null, true, and false only, so the
  /// operand is `Bool?` and nil is the null test.
  public static func `is`(_ column: String, _ value: Bool?) -> [String: Any] {
    ["kind": "is", "column": column, "value": value ?? NSNull()]
  }

  /// Membership in `values`.
  public static func `in`(_ column: String, _ values: [Any]) -> [String: Any] {
    ["kind": "in", "column": column, "values": values]
  }

  /// The column contains `value`.
  public static func contains(_ column: String, _ value: Any) -> [String: Any] {
    ["kind": "contains", "column": column, "value": value]
  }

  /// The column is contained by `value`.
  public static func containedBy(_ column: String, _ value: Any) -> [String: Any] {
    ["kind": "containedBy", "column": column, "value": value]
  }

  /// Every nested filter has to match.
  public static func and(_ filters: [[String: Any]]) -> [String: Any] {
    ["kind": "and", "filters": filters]
  }

  /// At least one nested filter has to match.
  public static func or(_ filters: [[String: Any]]) -> [String: Any] {
    ["kind": "or", "filters": filters]
  }

  /// Negates the nested filter.
  public static func not(_ filter: [String: Any]) -> [String: Any] {
    ["kind": "not", "filter": filter]
  }

  /// Free-text search over `columns`, or over every text column when it is nil.
  public static func search(_ query: String, columns: [String]? = nil) -> [String: Any] {
    var filter: [String: Any] = ["kind": "search", "query": query]
    if let columns {
      filter["columns"] = columns
    }
    return filter
  }

  /// Text search over one column in the given parse mode.
  public static func textSearch(
    _ column: String,
    _ query: String,
    type: KizunaSyncTextSearchType = .plain
  ) -> [String: Any] {
    ["kind": "textSearch", "column": column, "query": query, "type": type.rawValue]
  }

  /// One sort key. `nullsFirst` left nil keeps the engine's default placement.
  public static func order(
    _ column: String,
    ascending: Bool = true,
    nullsFirst: Bool? = nil
  ) -> [String: Any] {
    var key: [String: Any] = ["column": column, "ascending": ascending]
    if let nullsFirst {
      key["nullsFirst"] = nullsFirst
    }
    return key
  }

  /// A whole query plan. `projection` nil selects every column, and
  /// `includeDeleted` true brings back the rows a soft-delete column marks.
  public static func plan(
    filters: [[String: Any]] = [],
    order: [[String: Any]] = [],
    limit: Int? = nil,
    projection: [String]? = nil,
    cardinality: String = "many",
    includeDeleted: Bool = false
  ) -> [String: Any] {
    var plan: [String: Any] = ["filters": filters, "cardinality": cardinality]
    if !order.isEmpty {
      plan["orders"] = order
    }
    if let limit {
      plan["limit"] = limit
    }
    if let projection {
      plan["projection"] = projection
    }
    if includeDeleted {
      plan["includeDeleted"] = true
    }
    return plan
  }

  /// A plan that answers with every matching row.
  public static func many(filters: [[String: Any]] = []) -> [String: Any] {
    plan(filters: filters, cardinality: "many")
  }

  /// A plan that requires exactly one matching row.
  public static func single(filters: [[String: Any]] = []) -> [String: Any] {
    plan(filters: filters, cardinality: "single")
  }

  /// A plan that allows zero or one matching row.
  public static func maybeSingle(filters: [[String: Any]] = []) -> [String: Any] {
    plan(filters: filters, cardinality: "maybeSingle")
  }
}

#if canImport(KizunaSyncFfi)

/// One event from the engine's bus.
public typealias KizunaSyncEngineEvent = FfiEngineEvent
/// The state of one attachment object.
public typealias KizunaSyncAttachmentStatus = FfiAttachmentStatus
/// One server refusal held in the journal.
public typealias KizunaSyncRejection = FfiRejection
/// The pull cursor, and whether and why the engine keeps pull and push off the
/// network until `reset()`.
public typealias KizunaSyncCheckpoint = FfiCheckpoint
/// What `fromFile` staged: the reference and the local path.
public typealias KizunaSyncFromFileResult = FfiFromFileResult

/**
 * One journalled column overwrite: a value this device wrote that a peer's push
 * replaced. The winner is somebody else's write, so the entry carries its own
 * `id` and that is what `dismissOverwrite` acknowledges.
 */
public struct KizunaSyncOverwrite: Equatable, Sendable {
  /// The journal row's own identifier.
  public let id: Int64
  /// The synced table the overwritten row belongs to.
  public let table: String
  /// The row's primary key.
  public let pk: String
  /// The column whose value was replaced.
  public let column: String
  /// The value this device lost, as JSON.
  public let loserValueJson: String
  /// The winning peer write's exactly-once identifier.
  public let winnerMutationId: String
  /// The rule that decided it, `arrival` or `hlc`.
  public let conflictMode: String
  /// The changelog sequence the winning value arrived on, when the pull page
  /// carried one.
  public let winnerSeq: String?
  /// When the journal recorded it, in epoch milliseconds.
  public let at: Int64
  /// Whether the app dismissed it.
  public let dismissed: Bool

  /// Read one journal row out of the `overwrites` payload. Answers nil when the
  /// object is not one, so a malformed row is dropped rather than invented.
  static func from(_ raw: Any) -> KizunaSyncOverwrite? {
    guard let row = raw as? [String: Any],
          let id = row["id"] as? Int64 ?? (row["id"] as? Int).map(Int64.init),
          let table = row["table"] as? String,
          let pk = row["pk"] as? String,
          let column = row["column"] as? String,
          let winnerMutationId = row["winner_mutation_id"] as? String,
          let conflictMode = row["conflict_mode"] as? String
    else { return nil }
    let at = row["at"] as? Int64 ?? (row["at"] as? Int).map(Int64.init) ?? 0
    return KizunaSyncOverwrite(
      id: id,
      table: table,
      pk: pk,
      column: column,
      loserValueJson: jsonText(row["loser_value"]),
      winnerMutationId: winnerMutationId,
      conflictMode: conflictMode,
      winnerSeq: row["winner_seq"] as? String,
      at: at,
      dismissed: row["dismissed"] as? Bool ?? false
    )
  }
}

/// The JSON rendering of one decoded value, the form `FfiRejection.serverRowJson`
/// and `FfiEngineEvent.columnOverwritten` already carry across the bridge.
private func jsonText(_ value: Any?) -> String {
  guard let value, !(value is NSNull) else { return "null" }
  guard let data = try? JSONSerialization.data(
    withJSONObject: value,
    options: [.fragmentsAllowed]
  ),
    let text = String(data: data, encoding: .utf8)
  else { return "null" }
  return text
}

private final class HostEventObserver: EventObserver, @unchecked Sendable {
  let handler: @Sendable (FfiEngineEvent) -> Void
  init(_ handler: @escaping @Sendable (FfiEngineEvent) -> Void) {
    self.handler = handler
  }
  func onEvent(event: FfiEngineEvent) {
    handler(event)
  }
}

private final class HostAttachmentListener: AttachmentListener, @unchecked Sendable {
  let handler: @Sendable (FfiAttachmentStatus) -> Void
  init(_ handler: @escaping @Sendable (FfiAttachmentStatus) -> Void) {
    self.handler = handler
  }
  func onStatus(status: FfiAttachmentStatus) {
    handler(status)
  }
}

/// Idiomatic host over the generated UniFFI engine. Every call hops off the
/// calling thread so `sync()` cannot block the iOS main actor.
public final class KizunaSyncClient: @unchecked Sendable {
  private let engine: KizunaSyncFfi.KizunaSyncEngine
  private let stateLock = NSLock()
  /// The table names the last successful `create` declared. `from(_:)` reads
  /// them, so an unconfigured table fails at the call rather than at execute.
  private var configuredTables: Set<String> = []
  private var attachedInspector: KizunaSyncInspector?

  /// Build a client over a fresh engine.
  public init() {
    self.engine = KizunaSyncFfi.KizunaSyncEngine()
  }

  /**
   * Takes the engine instead of building one, so a test can pass a subclass
   * built with `KizunaSyncEngine(noHandle:)` and drive the error mapping without a
   * live Rust engine behind it.
   */
  public init(engine: KizunaSyncFfi.KizunaSyncEngine) {
    self.engine = engine
  }

  /// Open the store and declare the synced tables.
  ///
  /// Throws `ATTACHMENT_PORTS_MISSING` when a table declares attachments and
  /// `attachmentRoot` is unset, `CONFIG_INVALID` when `clientId` is not a uuid,
  /// and whatever the engine reports otherwise.
  public func create(_ config: KizunaSyncClientConfig) async throws {
    if config.declaresAttachments && config.attachmentRoot == nil {
      throw KizunaSyncError.engine(
        code: KizunaSyncErrorCode.attachmentPortsMissing,
        message: "a table declares attachments but attachmentRoot is unset"
      )
    }
    guard config.carriesUuidClientId else {
      throw KizunaSyncError.engine(
        code: KizunaSyncErrorCode.configInvalid,
        message: "clientId must be a uuid, got \"\(config.clientId)\""
      )
    }
    let json = try config.jsonString()
    try await runOffCallingThread { try self.engine.create(configJson: json) }
    recordConfiguredTables(Set(config.tables.keys))
  }

  /// Queue one mutation against one row.
  ///
  /// Throws `LOCAL_UNSUPPORTED` when `table` or `pk` is empty, and the engine's
  /// code otherwise.
  public func apply(
    table: String,
    pk: String,
    op: KizunaSyncOp,
    columns: [String: Any] = [:],
    mutationId: String? = nil,
    transforms: [String: Any]? = nil,
    precondition: [String: Any]? = nil
  ) async throws {
    if table.isEmpty || pk.isEmpty {
      throw KizunaSyncError.engine(
        code: KizunaSyncErrorCode.localUnsupported,
        message: "apply requires table and pk"
      )
    }
    var mutation: [String: Any] = [
      "table": table,
      "pk": pk,
      "op": op.rawValue,
      "columns": columns,
    ]
    if let mutationId {
      mutation["mutation_id"] = mutationId
    }
    if let transforms {
      mutation["transforms"] = transforms
    }
    if let precondition {
      mutation["precondition"] = precondition
    }
    let json = try encode(mutation)
    try await runOffCallingThread { try self.engine.apply(mutationJson: json) }
  }

  /// Queue one mutation per row the filters target, and answer with their primary keys.
  ///
  /// Throws `LOCAL_UNSUPPORTED` when `filters` is empty, and the engine's code otherwise.
  public func applyWhere(
    table: String,
    op: KizunaSyncOp,
    filters: [[String: Any]],
    columns: [String: Any] = [:],
    transforms: [String: Any]? = nil,
    precondition: [String: Any]? = nil
  ) async throws -> [String] {
    try await runOffCallingThread {
      try self.engine.applyWhere(
        table: table,
        op: op.rawValue,
        filtersJson: try self.encode(filters),
        columnsJson: try self.encode(columns),
        transformsJson: try self.encode(transforms ?? [:]),
        preconditionJson: try self.encode(precondition ?? [:])
      )
    }
  }

  /// Run one plan and answer with the decoded JSON the engine returned.
  ///
  /// Throws the engine's code, `LOCAL_CONSTRAINT` for a cardinality miss,
  /// `LOCAL_UNSUPPORTED` for a construct the local subset cannot answer, and
  /// `ENGINE_UNAVAILABLE` for an answer that is not JSON.
  public func query(table: String, plan: [String: Any] = [:]) async throws -> Any {
    let raw = try await runOffCallingThread {
      try self.engine.queryTable(table: table, planJson: try self.encode(plan))
    }
    guard let decoded = try? JSONSerialization.jsonObject(
      with: Data(raw.utf8),
      options: [.fragmentsAllowed]
    ) else {
      throw KizunaSyncError.engine(
        code: KizunaSyncErrorCode.engineUnavailable,
        message: "query: unreadable payload"
      )
    }
    return decoded
  }

  /// Push the outbox, move the queued attachment bytes, then pull, in one pass.
  ///
  /// Throws whatever the engine or the remote reported.
  public func sync() async throws {
    try await runOffCallingThread { try self.engine.sync() }
  }

  /// Pull once, without pushing.
  ///
  /// Throws whatever the engine or the remote reported.
  public func pullOnce() async throws {
    try await runOffCallingThread { try self.engine.pullOnce() }
  }

  /// Push the outbox once, without pulling.
  ///
  /// Throws whatever the engine or the remote reported.
  public func pushOnce() async throws {
    try await runOffCallingThread { try self.engine.pushOnce() }
  }

  /// How many mutations are still queued.
  ///
  /// Throws the store's code when the queue cannot be read.
  public func outboxDepth() async throws -> Int {
    try await runOffCallingThread { Int(try self.engine.outboxDepth()) }
  }

  /// Swap the JWT the remote sends. Passing nil clears it.
  ///
  /// Throws the engine's code when the client has no engine yet.
  public func setAccessToken(_ token: String?) async throws {
    try await runOffCallingThread { try self.engine.setAccessToken(token: token) }
  }

  /// Rebind the bucket predicate's values.
  ///
  /// Throws the engine's code when the params cannot be read.
  public func setBucket(_ params: [String: Any]) async throws {
    try await runOffCallingThread {
      try self.engine.setBucket(paramsJson: try self.encode(params))
    }
  }

  /// The server refusals held in the journal.
  ///
  /// Throws the store's code when the journal cannot be read.
  public func rejections(includeDismissed: Bool = false) async throws -> [KizunaSyncRejection] {
    try await runOffCallingThread {
      try self.engine.rejections(includeDismissed: includeDismissed)
    }
  }

  /// Mark one refusal as seen. Answers false when no such refusal is held.
  ///
  /// Throws the store's code when the journal cannot be written.
  public func dismissRejection(_ mutationId: String) async throws -> Bool {
    try await runOffCallingThread {
      try self.engine.dismissRejection(mutationId: mutationId)
    }
  }

  /// The column overwrites held in the journal, newest first: the values this
  /// device wrote that a peer's push replaced.
  ///
  /// Throws the store's code when the journal cannot be read.
  public func overwrites(includeDismissed: Bool = false) async throws -> [KizunaSyncOverwrite] {
    let value = try await invoke(
      method: "overwrites",
      params: ["include_dismissed": includeDismissed]
    )
    guard let rows = value as? [Any] else { return [] }
    return rows.compactMap(KizunaSyncOverwrite.from)
  }

  /// Acknowledge one journalled overwrite by its own id. Answers false when no
  /// entry carries it.
  ///
  /// Throws the store's code when the journal cannot be written.
  @discardableResult
  public func dismissOverwrite(_ id: Int64) async throws -> Bool {
    try await invoke(method: "dismiss_overwrite", params: ["id": id]) as? Bool ?? false
  }

  /// Take one permanently failed attachment back: the transfer budget is
  /// forgiven and the next drive sees the row again. Answers false when no row
  /// carries the reference.
  ///
  /// Throws the store's code when the row cannot be written.
  @discardableResult
  public func attachmentRetry(_ reference: String) async throws -> Bool {
    try await invoke(method: "attachment_retry", params: ["reference": reference]) as? Bool ?? false
  }

  /// Stop one transfer at the app's request. The row lands `failed` and stays
  /// retryable, so the next drive may take it. Answers false when no row
  /// carries the reference.
  ///
  /// Throws the store's code when the row cannot be written.
  @discardableResult
  public func attachmentCancel(_ reference: String) async throws -> Bool {
    try await invoke(method: "attachment_cancel", params: ["reference": reference]) as? Bool ?? false
  }

  /// Forget one attachment row and answer the sandbox path whose bytes the app
  /// still has to delete, or nil when the row carried none or did not exist.
  ///
  /// Throws the store's code when the row cannot be written.
  @discardableResult
  public func attachmentRemove(_ reference: String) async throws -> String? {
    try await invoke(method: "attachment_remove", params: ["reference": reference]) as? String
  }

  /// Drop every local row, the outbox, the cursor, and the journals, keep a
  /// newly minted client identity, and answer with the attachment sandbox
  /// paths whose bytes the app still has to delete.
  ///
  /// Throws the store's code when the wipe cannot be written.
  public func reset() async throws -> [String] {
    try await runOffCallingThread { try self.engine.reset() }
  }

  /// The pull cursor, and whether and why the engine keeps pull and push off the
  /// network until `reset()` runs.
  ///
  /// Throws the store's code when the cursor cannot be read.
  public func checkpoint() async throws -> KizunaSyncCheckpoint {
    try await runOffCallingThread { try self.engine.checkpoint() }
  }

  /// Adopt a cursor the host already holds, skipping the rows behind it.
  ///
  /// Throws the store's code when the cursor cannot be written.
  public func seedCheckpoint(_ cursor: String) async throws {
    try await runOffCallingThread { try self.engine.seedCheckpoint(cursor: cursor) }
  }

  /// Subscribe to engine events. Returns an unsubscribe function.
  ///
  /// Throws the engine's code when the client has no engine yet.
  public func on(_ handler: @escaping @Sendable (KizunaSyncEngineEvent) -> Void) async throws -> @Sendable () -> Void {
    let observer = HostEventObserver(handler)
    let id = try await runOffCallingThread {
      try self.engine.subscribe(observer: observer)
    }
    return {
      Task { try? await self.runOffCallingThread { try self.engine.unsubscribe(subscriptionId: id) } }
    }
  }

  /// Stage a local file as the attachment of one row and queue its upload.
  ///
  /// Throws the transfer's code when the bytes cannot be staged.
  public func fromFile(
    table: String,
    column: String,
    pk: String,
    sourcePath: String,
    mediaType: String? = nil
  ) async throws -> KizunaSyncFromFileResult {
    try await runOffCallingThread {
      try self.engine.fromFile(
        table: table,
        column: column,
        pk: pk,
        sourcePath: sourcePath,
        mediaType: mediaType
      )
    }
  }

  /// The local path of an attachment, or nil while its bytes are still remote.
  ///
  /// Throws the transfer's code when the download cannot be resolved.
  public func resolveDownload(_ reference: String) async throws -> String? {
    try await runOffCallingThread { try self.engine.resolveDownload(reference: reference) }
  }

  /// Drop the staged bytes no row references any more.
  ///
  /// Throws the store's code when the sweep cannot run.
  public func vacuum() async throws {
    try await runOffCallingThread { try self.engine.vacuum() }
  }

  /// The state of one attachment, or nil when the engine holds none.
  ///
  /// Throws the store's code when the state cannot be read.
  public func getStatus(_ reference: String) async throws -> KizunaSyncAttachmentStatus? {
    try await runOffCallingThread { try self.engine.getStatus(reference: reference) }
  }

  /// Watch one attachment. Returns an unwatch function.
  ///
  /// Throws the engine's code when the client has no engine yet.
  public func watch(
    _ reference: String,
    onStatus: @escaping @Sendable (KizunaSyncAttachmentStatus) -> Void
  ) async throws -> @Sendable () -> Void {
    let listener = HostAttachmentListener(onStatus)
    let id = try await runOffCallingThread {
      try self.engine.watch(reference: reference, listener: listener)
    }
    return {
      Task { try? await self.runOffCallingThread { try self.engine.unwatch(watchId: id) } }
    }
  }

  /// The raw devtools snapshot of the command queue. `KizunaSyncInspector.snapshot()`
  /// is the typed reading of the same five fields.
  ///
  /// Throws `ENGINE_UNAVAILABLE` when the payload is not an object, and the
  /// engine's code otherwise.
  public func inspect() async throws -> [String: Any] {
    let raw = try await runOffCallingThread { try self.engine.inspect() }
    guard let snapshot = decodedObject(raw) else {
      throw KizunaSyncError.engine(
        code: KizunaSyncErrorCode.engineUnavailable,
        message: "inspect: expected an object"
      )
    }
    return snapshot
  }

  /// The devtools inspector over this client: the queue snapshot plus the
  /// bounded verdict ring the engine's event bus feeds. One per client, so
  /// every caller reads the same ring.
  ///
  /// Throws the engine's code when the event subscription cannot be installed.
  public func inspector() async throws -> KizunaSyncInspector {
    if let existing = existingInspector() {
      return existing
    }
    let created = KizunaSyncInspector(client: self)
    try await created.attach()
    let winner = adoptInspector(created)
    if winner !== created {
      created.detach()
    }
    return winner
  }

  /// Close the engine and its store. Further calls fail with `ENGINE_UNAVAILABLE`.
  public func dispose() async {
    releaseInspectorAndTables()?.detach()
    try? await runOffCallingThread { try self.engine.shutdown() }
  }

  /// The fluent surface of one table.
  ///
  /// Throws `UNKNOWN_TABLE` when the table is absent from the config the last
  /// `create` declared, because reads and filter-targeted writes on it would
  /// otherwise no-op with no bucket and no sync rules.
  public func from(_ table: String) throws -> KizunaSyncTable {
    stateLock.lock()
    let known = configuredTables
    stateLock.unlock()
    guard known.contains(table) else {
      let configured = known.sorted().joined(separator: ", ")
      throw KizunaSyncError.engine(
        code: KizunaSyncErrorCode.unknownTable,
        message: "from(\"\(table)\"): table is not in the kizunasync config (configured: \(configured.isEmpty ? "none" : configured))"
      )
    }
    return KizunaSyncTable(client: self, table: table)
  }

  private func recordConfiguredTables(_ tables: Set<String>) {
    stateLock.lock()
    configuredTables = tables
    stateLock.unlock()
  }

  private func existingInspector() -> KizunaSyncInspector? {
    stateLock.lock()
    defer { stateLock.unlock() }
    return attachedInspector
  }

  /// Publishes `created` unless another caller won the race, and answers with
  /// whichever inspector is now the client's one.
  private func adoptInspector(_ created: KizunaSyncInspector) -> KizunaSyncInspector {
    stateLock.lock()
    defer { stateLock.unlock() }
    if let winner = attachedInspector {
      return winner
    }
    attachedInspector = created
    return created
  }

  private func releaseInspectorAndTables() -> KizunaSyncInspector? {
    stateLock.lock()
    defer { stateLock.unlock() }
    let inspector = attachedInspector
    attachedInspector = nil
    configuredTables = []
    return inspector
  }

  /**
   * One kernel method the typed surface does not export, through the same
   * JSON-RPC envelope every bridge answers. A refused call arrives as
   * `KizunaSyncError.engine` carrying the kernel's own code, so a caller switches on
   * `code` here exactly as it does on a typed method.
   *
   * Throws `ENGINE_UNAVAILABLE` when the envelope cannot be read or carries no
   * code, because an envelope this client cannot read is not a gradeable
   * failure.
   */
  private func invoke(method: String, params: [String: Any]) async throws -> Any {
    let raw = try await runOffCallingThread {
      try self.engine.call(method: method, paramsJson: try self.encode(params))
    }
    guard let envelope = decodedObject(raw) else {
      throw KizunaSyncError.engine(
        code: KizunaSyncErrorCode.engineUnavailable,
        message: "\(method): unreadable envelope"
      )
    }
    if envelope["ok"] as? Bool == true {
      return envelope["value"] ?? NSNull()
    }
    let failure = envelope["error"] as? [String: Any]
    throw KizunaSyncError.engine(
      code: failure?["code"] as? String ?? KizunaSyncErrorCode.engineUnavailable,
      message: failure?["message"] as? String ?? "\(method) failed"
    )
  }

  /// The JSON object `raw` spells, or nil when it is not JSON or not an object.
  private func decodedObject(_ raw: String) -> [String: Any]? {
    (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any]
  }

  private func encode(_ object: Any) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed])
    guard let json = String(data: data, encoding: .utf8) else {
      throw KizunaSyncError.engine(
        code: KizunaSyncErrorCode.engineUnavailable,
        message: "payload is not utf8"
      )
    }
    return json
  }

  /**
   * Every FFI call blocks its thread until the engine answers, so it runs on
   * this queue and never on the cooperative pool. The queue is concurrent
   * because the engine actor already serializes network calls, and a local
   * call must not wait behind a sync.
   */
  private static let ffiQueue = DispatchQueue(
    label: "com.kizunasync.kizunasync.ffi",
    qos: .userInitiated,
    attributes: .concurrent
  )

  private func runOffCallingThread<T: Sendable>(_ body: @escaping @Sendable () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
      Self.ffiQueue.async {
        do {
          continuation.resume(returning: try body())
        } catch let error as KizunaSyncFfiError {
          continuation.resume(throwing: mapFfi(error))
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }
  }
}

private func mapFfi(_ error: KizunaSyncFfiError) -> KizunaSyncError {
  switch error {
  case .Engine(let code, let msg):
    return .engine(code: code, message: msg)
  }
}

#endif
