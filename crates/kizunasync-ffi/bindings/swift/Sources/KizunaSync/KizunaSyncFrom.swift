import Foundation
#if canImport(KizunaSyncFfi)

/// Table-scoped fluent surface matching JavaScript `kizunasync.from(table)`.
public final class KizunaSyncTable: @unchecked Sendable {
  private let client: KizunaSyncClient
  private let table: String

  init(client: KizunaSyncClient, table: String) {
    self.client = client
    self.table = table
  }

  /**
   * Queue one insert. A non-empty `String` under `"id"` is the row's primary
   * key; anything else leaves `columns` as given and mints a key beside it, so
   * the engine refuses the divergent identifier with `LOCAL_CONSTRAINT` rather
   * than discarding it.
   *
   * Throws the engine's code, `LOCAL_CONSTRAINT` for a divergent or duplicate
   * primary key and `UNKNOWN_TABLE` for a table the config never declared.
   */
  public func insert(_ columns: [String: Any]) async throws {
    let pk: String
    if let existing = columns["id"] as? String, !existing.isEmpty {
      pk = existing
    } else {
      pk = UUID().uuidString.lowercased()
    }
    try await client.apply(table: table, pk: pk, op: .insert, columns: columns)
  }

  /// Start an update of `columns` over the rows the filters target.
  public func update(
    _ columns: [String: Any],
    transforms: [String: Any]? = nil,
    precondition: [String: Any]? = nil
  ) -> KizunaSyncWriteBuilder {
    KizunaSyncWriteBuilder(
      client: client,
      table: table,
      op: .update,
      columns: columns,
      transforms: transforms,
      precondition: precondition
    )
  }

  /// Start a delete over the rows the filters target. The store's delete path
  /// reads neither columns nor transforms, so the builder carries only a
  /// precondition.
  public func delete(precondition: [String: Any]? = nil) -> KizunaSyncWriteBuilder {
    KizunaSyncWriteBuilder(
      client: client,
      table: table,
      op: .delete,
      columns: [:],
      transforms: nil,
      precondition: precondition
    )
  }

  /// Start a read. `columns` is a comma-separated projection; nil and `"*"`
  /// select every column. Relational embeds and renames are not part of the
  /// local subset and the engine refuses them with `LOCAL_UNSUPPORTED`.
  public func select(_ columns: String? = nil) -> KizunaSyncSelectBuilder {
    KizunaSyncSelectBuilder(client: client, table: table, projection: Self.projection(columns))
  }

  private static func projection(_ columns: String?) -> [String]? {
    guard let columns else { return nil }
    let trimmed = columns.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty || trimmed == "*" { return nil }
    return trimmed
      .split(separator: ",", omittingEmptySubsequences: false)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
  }
}

/// Fluent read over one table. Every filter is the same AST `KizunaSyncQuery` builds.
public final class KizunaSyncSelectBuilder: @unchecked Sendable {
  private let client: KizunaSyncClient
  private let table: String
  private var filters: [[String: Any]] = []
  private var orders: [[String: Any]] = []
  private var limitCount: Int?
  private var includeDeletedRows = false
  private let projection: [String]?

  init(client: KizunaSyncClient, table: String, projection: [String]?) {
    self.client = client
    self.table = table
    self.projection = projection
  }

  /// Keep the rows whose column equals `value`.
  @discardableResult public func eq(_ column: String, _ value: Any) -> KizunaSyncSelectBuilder {
    filters.append(KizunaSyncQuery.eq(column, value))
    return self
  }

  /// Keep the rows whose column differs from `value`.
  @discardableResult public func neq(_ column: String, _ value: Any) -> KizunaSyncSelectBuilder {
    filters.append(KizunaSyncQuery.neq(column, value))
    return self
  }

  /// Keep the rows whose column is greater than `value`.
  @discardableResult public func gt(_ column: String, _ value: Any) -> KizunaSyncSelectBuilder {
    filters.append(KizunaSyncQuery.gt(column, value))
    return self
  }

  /// Keep the rows whose column is greater than or equal to `value`.
  @discardableResult public func gte(_ column: String, _ value: Any) -> KizunaSyncSelectBuilder {
    filters.append(KizunaSyncQuery.gte(column, value))
    return self
  }

  /// Keep the rows whose column is less than `value`.
  @discardableResult public func lt(_ column: String, _ value: Any) -> KizunaSyncSelectBuilder {
    filters.append(KizunaSyncQuery.lt(column, value))
    return self
  }

  /// Keep the rows whose column is less than or equal to `value`.
  @discardableResult public func lte(_ column: String, _ value: Any) -> KizunaSyncSelectBuilder {
    filters.append(KizunaSyncQuery.lte(column, value))
    return self
  }

  /// Keep the rows whose column matches the case-sensitive pattern.
  @discardableResult public func like(_ column: String, _ pattern: String) -> KizunaSyncSelectBuilder {
    filters.append(KizunaSyncQuery.like(column, pattern))
    return self
  }

  /// Keep the rows whose column matches the case-insensitive pattern.
  @discardableResult public func ilike(_ column: String, _ pattern: String) -> KizunaSyncSelectBuilder {
    filters.append(KizunaSyncQuery.ilike(column, pattern))
    return self
  }

  /// Keep the rows whose column is null, true, or false. nil is the null test.
  @discardableResult public func `is`(_ column: String, _ value: Bool?) -> KizunaSyncSelectBuilder {
    filters.append(KizunaSyncQuery.`is`(column, value))
    return self
  }

  /// Keep the rows whose column is one of `values`.
  @discardableResult public func `in`(_ column: String, _ values: [Any]) -> KizunaSyncSelectBuilder {
    filters.append(KizunaSyncQuery.`in`(column, values))
    return self
  }

  /// Keep the rows whose column contains `value`.
  @discardableResult public func contains(_ column: String, _ value: Any) -> KizunaSyncSelectBuilder {
    filters.append(KizunaSyncQuery.contains(column, value))
    return self
  }

  /// Keep the rows whose column is contained by `value`.
  @discardableResult public func containedBy(_ column: String, _ value: Any) -> KizunaSyncSelectBuilder {
    filters.append(KizunaSyncQuery.containedBy(column, value))
    return self
  }

  /// Keep the rows at least one nested filter matches.
  @discardableResult public func or(_ filters: [[String: Any]]) -> KizunaSyncSelectBuilder {
    self.filters.append(KizunaSyncQuery.or(filters))
    return self
  }

  /// Keep the rows every nested filter matches.
  @discardableResult public func and(_ filters: [[String: Any]]) -> KizunaSyncSelectBuilder {
    self.filters.append(KizunaSyncQuery.and(filters))
    return self
  }

  /// Keep the rows the nested filter rejects.
  @discardableResult public func not(_ filter: [String: Any]) -> KizunaSyncSelectBuilder {
    filters.append(KizunaSyncQuery.not(filter))
    return self
  }

  /// Keep the rows matching a free-text query over `columns`, or over every
  /// text column when it is nil.
  @discardableResult public func search(_ query: String, columns: [String]? = nil) -> KizunaSyncSelectBuilder {
    filters.append(KizunaSyncQuery.search(query, columns: columns))
    return self
  }

  /// Keep the rows whose column matches a text-search query in the given parse mode.
  @discardableResult public func textSearch(
    _ column: String,
    _ query: String,
    type: KizunaSyncTextSearchType = .plain
  ) -> KizunaSyncSelectBuilder {
    filters.append(KizunaSyncQuery.textSearch(column, query, type: type))
    return self
  }

  /// Append one sort key.
  @discardableResult public func order(
    _ column: String,
    ascending: Bool = true,
    nullsFirst: Bool? = nil
  ) -> KizunaSyncSelectBuilder {
    orders.append(KizunaSyncQuery.order(column, ascending: ascending, nullsFirst: nullsFirst))
    return self
  }

  /// Cap how many rows come back. A count below zero is `LOCAL_UNSUPPORTED`.
  @discardableResult public func limit(_ count: Int) -> KizunaSyncSelectBuilder {
    limitCount = count
    return self
  }

  /// Bring back the rows the table's soft-delete column marks, which every read
  /// leaves out by default. A table that declares no such column is unaffected.
  @discardableResult public func includeDeleted() -> KizunaSyncSelectBuilder {
    includeDeletedRows = true
    return self
  }

  /// Run the plan and answer with the decoded row array.
  ///
  /// Throws the engine's code, `LOCAL_UNSUPPORTED` for a construct outside the
  /// local subset and `UNKNOWN_TABLE` for a table the config never declared.
  public func execute() async throws -> Any {
    try await client.query(table: table, plan: plan(cardinality: "many"))
  }

  /// Run the plan and answer with the one matching row.
  ///
  /// Throws `LOCAL_CONSTRAINT` when the plan matched anything other than one row.
  public func single() async throws -> Any {
    try await client.query(table: table, plan: plan(cardinality: "single"))
  }

  /// Run the plan and answer with the one matching row, or null when none matched.
  ///
  /// Throws `LOCAL_CONSTRAINT` when the plan matched more than one row.
  public func maybeSingle() async throws -> Any {
    try await client.query(table: table, plan: plan(cardinality: "maybeSingle"))
  }

  private func plan(cardinality: String) -> [String: Any] {
    KizunaSyncQuery.plan(
      filters: filters,
      order: orders,
      limit: limitCount,
      projection: projection,
      cardinality: cardinality,
      includeDeleted: includeDeletedRows
    )
  }
}

/// Fluent filter-targeted write over one table. It carries the comparison,
/// pattern, null, list, containment, clause-list, and negation operators;
/// `search` and `textSearch` stay on the read builder.
public final class KizunaSyncWriteBuilder: @unchecked Sendable {
  private let client: KizunaSyncClient
  private let table: String
  private let op: KizunaSyncOp
  private let columns: [String: Any]
  private let transforms: [String: Any]?
  private let precondition: [String: Any]?
  private var filters: [[String: Any]] = []

  init(
    client: KizunaSyncClient,
    table: String,
    op: KizunaSyncOp,
    columns: [String: Any],
    transforms: [String: Any]?,
    precondition: [String: Any]?
  ) {
    self.client = client
    self.table = table
    self.op = op
    self.columns = columns
    self.transforms = transforms
    self.precondition = precondition
  }

  /// Target the rows whose column equals `value`.
  @discardableResult public func eq(_ column: String, _ value: Any) -> KizunaSyncWriteBuilder {
    filters.append(KizunaSyncQuery.eq(column, value))
    return self
  }

  /// Target the rows whose column differs from `value`.
  @discardableResult public func neq(_ column: String, _ value: Any) -> KizunaSyncWriteBuilder {
    filters.append(KizunaSyncQuery.neq(column, value))
    return self
  }

  /// Target the rows whose column is greater than `value`.
  @discardableResult public func gt(_ column: String, _ value: Any) -> KizunaSyncWriteBuilder {
    filters.append(KizunaSyncQuery.gt(column, value))
    return self
  }

  /// Target the rows whose column is greater than or equal to `value`.
  @discardableResult public func gte(_ column: String, _ value: Any) -> KizunaSyncWriteBuilder {
    filters.append(KizunaSyncQuery.gte(column, value))
    return self
  }

  /// Target the rows whose column is less than `value`.
  @discardableResult public func lt(_ column: String, _ value: Any) -> KizunaSyncWriteBuilder {
    filters.append(KizunaSyncQuery.lt(column, value))
    return self
  }

  /// Target the rows whose column is less than or equal to `value`.
  @discardableResult public func lte(_ column: String, _ value: Any) -> KizunaSyncWriteBuilder {
    filters.append(KizunaSyncQuery.lte(column, value))
    return self
  }

  /// Target the rows whose column matches the case-sensitive pattern.
  @discardableResult public func like(_ column: String, _ pattern: String) -> KizunaSyncWriteBuilder {
    filters.append(KizunaSyncQuery.like(column, pattern))
    return self
  }

  /// Target the rows whose column matches the case-insensitive pattern.
  @discardableResult public func ilike(_ column: String, _ pattern: String) -> KizunaSyncWriteBuilder {
    filters.append(KizunaSyncQuery.ilike(column, pattern))
    return self
  }

  /// Target the rows whose column is null, true, or false. nil is the null test.
  @discardableResult public func `is`(_ column: String, _ value: Bool?) -> KizunaSyncWriteBuilder {
    filters.append(KizunaSyncQuery.`is`(column, value))
    return self
  }

  /// Target the rows whose column is one of `values`.
  @discardableResult public func `in`(_ column: String, _ values: [Any]) -> KizunaSyncWriteBuilder {
    filters.append(KizunaSyncQuery.`in`(column, values))
    return self
  }

  /// Target the rows whose column contains `value`.
  @discardableResult public func contains(_ column: String, _ value: Any) -> KizunaSyncWriteBuilder {
    filters.append(KizunaSyncQuery.contains(column, value))
    return self
  }

  /// Target the rows whose column is contained by `value`.
  @discardableResult public func containedBy(_ column: String, _ value: Any) -> KizunaSyncWriteBuilder {
    filters.append(KizunaSyncQuery.containedBy(column, value))
    return self
  }

  /// Target the rows at least one nested filter matches.
  @discardableResult public func or(_ filters: [[String: Any]]) -> KizunaSyncWriteBuilder {
    self.filters.append(KizunaSyncQuery.or(filters))
    return self
  }

  /// Target the rows every nested filter matches.
  @discardableResult public func and(_ filters: [[String: Any]]) -> KizunaSyncWriteBuilder {
    self.filters.append(KizunaSyncQuery.and(filters))
    return self
  }

  /// Target the rows the nested filter rejects.
  @discardableResult public func not(_ filter: [String: Any]) -> KizunaSyncWriteBuilder {
    filters.append(KizunaSyncQuery.not(filter))
    return self
  }

  /// Queue one mutation per targeted row and answer with their primary keys.
  ///
  /// Throws `LOCAL_UNSUPPORTED` when no filter was chained, because an
  /// unfiltered write would target the whole table.
  @discardableResult public func execute() async throws -> [String] {
    try await client.applyWhere(
      table: table,
      op: op,
      filters: filters,
      columns: columns,
      transforms: transforms,
      precondition: precondition
    )
  }
}

#endif
