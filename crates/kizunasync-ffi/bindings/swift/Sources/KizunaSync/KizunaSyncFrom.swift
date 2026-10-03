import Foundation
#if canImport(KizunaSyncFfi)

/// Table-scoped fluent surface matching JavaScript `kizunasync.from(table)`.
public final class KizunaSyncTable: @unchecked Sendable {
  private let client: KizunaSyncClient
  private let table: String
  private let key: [String]

  init(client: KizunaSyncClient, table: String, key: [String]) {
    self.client = client
    self.table = table
    self.key = key
  }

  /**
   * Queue one insert. A table keyed by `id` whose row names no `id` gets a
   * minted uuid; every other row's primary key is the one the engine derives
   * from the key columns, which must all be present as strings or integers.
   *
   * Throws the engine's code, `LOCAL_CONSTRAINT` for a missing or invalid key
   * column or a duplicate primary key and `UNKNOWN_TABLE` for a table the
   * config never declared.
   */
  public func insert(_ columns: [String: Any]) async throws {
    let mints = key == kizunasyncDefaultKey && columns["id"] == nil
    let pk = mints ? UUID().uuidString.lowercased() : ""
    try await client.queue(table: table, pk: pk, op: .insert, columns: columns)
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

  /// Start a read. `columns` is a comma-separated projection, and `"*"`
  /// selects every column. Relational embeds and renames are not part of the
  /// local subset and the engine refuses them with `LOCAL_UNSUPPORTED`.
  ///
  /// `count` asks for the rows the filters match before `range` and `limit`:
  /// every option returns the exact local count, and the terminals then answer
  /// `["rows": …, "count": n]`. `head` drops the rows from that answer.
  public func select(
    _ columns: String = "*",
    head: Bool = false,
    count: KizunaSyncCountOption? = nil
  ) -> KizunaSyncSelectBuilder {
    KizunaSyncSelectBuilder(
      client: client,
      table: table,
      projection: Self.projection(columns),
      isHead: head,
      isCounted: count != nil
    )
  }

  private static func projection(_ columns: String) -> [String]? {
    let trimmed = columns.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty || trimmed == "*" { return nil }
    return trimmed
      .split(separator: ",", omittingEmptySubsequences: false)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
  }
}

/// The row-count options `select(_:head:count:)` takes. Every one returns the
/// exact local count, since the kernel counts every match.
public enum KizunaSyncCountOption: String, Sendable {
  case exact
  case planned
  case estimated
}

/// Fluent read over one table. Every filter is the same AST `KizunaSyncQuery` builds.
public final class KizunaSyncSelectBuilder: @unchecked Sendable {
  private let client: KizunaSyncClient
  private let table: String
  private var filters: [[String: Any]] = []
  private var orders: [[String: Any]] = []
  private var limitCount: Int?
  private var offsetCount: Int?
  private var refusal: String?
  private var includeDeletedRows = false
  private var isStrippingNulls = false
  private let projection: [String]?
  private let isHead: Bool
  private let isCounted: Bool

  init(client: KizunaSyncClient, table: String, projection: [String]?, isHead: Bool, isCounted: Bool) {
    self.client = client
    self.table = table
    self.projection = projection
    self.isHead = isHead
    self.isCounted = isCounted
  }

  /// Keeps the first refusal: the read throws it when it runs.
  private func refuse(_ message: String) -> KizunaSyncSelectBuilder {
    refusal = refusal ?? message
    return self
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

  /// Keep the rows at indexes `from` through `to`, both inclusive and counted
  /// from zero after the sort, as supabase-js `range` does: the plan skips
  /// `from` rows and keeps `to - from + 1`, so a `to` one below `from` keeps
  /// none. A later `limit(_:)` replaces only the row count. A negative bound,
  /// or a `to` further below `from`, throws `LOCAL_UNSUPPORTED` when the read
  /// runs, and so does every read of this builder after it.
  @discardableResult public func range(from: Int, to: Int) -> KizunaSyncSelectBuilder {
    guard from >= 0, to >= 0, to >= from - 1 else {
      return refuse("range(\(from), \(to)): the bounds must be zero or more, and to at least from - 1")
    }
    offsetCount = from
    // range(from: 0, to: Int.max) spans one row more than Int counts; saturating still keeps every row.
    let (count, overflow) = (to - from).addingReportingOverflow(1)
    limitCount = overflow ? Int.max : count
    return self
  }

  /// Bring back the rows the table's soft-delete column marks, which every read
  /// leaves out by default. A table that declares no such column is unaffected.
  @discardableResult public func includeDeleted() -> KizunaSyncSelectBuilder {
    includeDeletedRows = true
    return self
  }

  /// Answer each row without its null-valued keys.
  @discardableResult public func stripNulls() -> KizunaSyncSelectBuilder {
    isStrippingNulls = true
    return self
  }

  /// Identity: a local read makes no network attempt to retry.
  @discardableResult public func retry(enabled: Bool) -> KizunaSyncSelectBuilder {
    self
  }

  /// Run the plan and answer with the decoded row array, or with
  /// `["rows": …, "count": n]` when `select` asked for a count or `head`.
  ///
  /// Throws the engine's code, `LOCAL_UNSUPPORTED` for a construct outside the
  /// local subset and `UNKNOWN_TABLE` for a table the config never declared.
  public func execute() async throws -> Any {
    try await run(cardinality: "many")
  }

  /// Run the plan and answer with the one matching row.
  ///
  /// Throws `LOCAL_CONSTRAINT` when the plan matched anything other than one row.
  public func single() async throws -> Any {
    try await run(cardinality: "single")
  }

  /// Run the plan and answer with the one matching row, or null when none matched.
  ///
  /// Throws `LOCAL_CONSTRAINT` when the plan matched more than one row.
  public func maybeSingle() async throws -> Any {
    try await run(cardinality: "maybeSingle")
  }

  /// Run the plan and answer with the rows as CSV text: a header of the
  /// selected columns in their order, or of every key the rows carry for `*`,
  /// then one line per row. A field holding a quote, a comma, or a line break
  /// is quoted per RFC 4180, null is an empty field, and an array or an object
  /// is its JSON text. A `head` read answers an empty string.
  public func csv() async throws -> String {
    let (rows, _) = try await answer(cardinality: "many")
    guard !isHead else { return "" }
    return KizunaSyncRowShaping.csv(rows as? [[String: Any]] ?? [], projection: projection)
  }

  private func run(cardinality: String) async throws -> Any {
    let (rows, count) = try await answer(cardinality: cardinality)
    let shaped: Any = isHead ? NSNull() : (isStrippingNulls ? KizunaSyncRowShaping.stripNulls(rows) : rows)
    guard isCounted || isHead else { return shaped }
    return ["rows": shaped, "count": count]
  }

  /// The kernel's answer, and the count beside it when the plan asked for one.
  private func answer(cardinality: String) async throws -> (rows: Any, count: Any) {
    let answer = try await client.query(table: table, plan: plan(cardinality: cardinality))
    guard isCounted, let counted = answer as? [String: Any] else { return (answer, NSNull()) }
    return (counted["rows"] ?? NSNull(), counted["count"] ?? NSNull())
  }

  private func plan(cardinality: String) throws -> [String: Any] {
    if let refusal {
      throw KizunaSyncError.engine(code: KizunaSyncErrorCode.localUnsupported, message: refusal)
    }
    var plan = KizunaSyncQuery.plan(
      filters: filters,
      order: orders,
      limit: limitCount,
      projection: projection,
      cardinality: cardinality,
      includeDeleted: includeDeletedRows
    )
    if let offsetCount {
      plan["offset"] = offsetCount
    }
    if isCounted {
      plan["count"] = true
    }
    return plan
  }
}

// MARK: - Select operators

extension KizunaSyncSelectBuilder {
  /// Keep the rows whose column matches the regular expression somewhere in
  /// its text, Postgres `~`. A pattern with a backreference or lookaround
  /// throws `LOCAL_UNSUPPORTED` naming it when the read runs.
  @discardableResult public func match(_ column: String, pattern: String) -> KizunaSyncSelectBuilder {
    append(KizunaSyncOperatorNode.regex(column, pattern, caseInsensitive: false))
  }

  /// Case-insensitive `match(_:pattern:)`, Postgres `~*`.
  @discardableResult public func imatch(_ column: String, pattern: String) -> KizunaSyncSelectBuilder {
    append(KizunaSyncOperatorNode.regex(column, pattern, caseInsensitive: true))
  }

  /// Keep the rows whose columns equal every value in `query`. An empty
  /// dictionary keeps every row.
  @discardableResult public func match(_ query: [String: Any?]) -> KizunaSyncSelectBuilder {
    append(KizunaSyncOperatorNode.match(query))
  }

  /// Keep the rows whose column matches every `like` pattern.
  @discardableResult public func likeAllOf(_ column: String, patterns: [String]) -> KizunaSyncSelectBuilder {
    append(KizunaSyncOperatorNode.patterns("like", column, patterns, any: false))
  }

  /// Keep the rows whose column matches any `like` pattern.
  @discardableResult public func likeAnyOf(_ column: String, patterns: [String]) -> KizunaSyncSelectBuilder {
    append(KizunaSyncOperatorNode.patterns("like", column, patterns, any: true))
  }

  /// Case-insensitive `likeAllOf(_:patterns:)`.
  @discardableResult public func iLikeAllOf(_ column: String, patterns: [String]) -> KizunaSyncSelectBuilder {
    append(KizunaSyncOperatorNode.patterns("ilike", column, patterns, any: false))
  }

  /// Case-insensitive `likeAnyOf(_:patterns:)`.
  @discardableResult public func iLikeAnyOf(_ column: String, patterns: [String]) -> KizunaSyncSelectBuilder {
    append(KizunaSyncOperatorNode.patterns("ilike", column, patterns, any: true))
  }

  /// Keep the rows whose column is distinct from `value`, treating null as a
  /// value, SQL `IS DISTINCT FROM`. nil is null.
  @discardableResult public func isDistinct(_ column: String, value: Any?) -> KizunaSyncSelectBuilder {
    append(KizunaSyncOperatorNode.isDistinct(column, value))
  }

  /// Keep the rows whose column is none of `values`, SQL `NOT IN`.
  @discardableResult public func notIn(_ column: String, values: [Any?]) -> KizunaSyncSelectBuilder {
    append(KizunaSyncOperatorNode.notIn(column, values))
  }

  /// Keep the rows whose array column shares an element with `value`, Postgres `&&`.
  @discardableResult public func overlaps(_ column: String, value: [Any?]) -> KizunaSyncSelectBuilder {
    append(KizunaSyncOperatorNode.overlaps(column, value))
  }

  /// Keep the rows one PostgREST clause, `column.operator.value`, selects. The
  /// operator is one of `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`,
  /// `ilike`, `is`, and `in`, optionally behind `not.`. Anything else throws
  /// `LOCAL_UNSUPPORTED` when the read runs.
  @discardableResult public func filter(_ column: String, operator op: String, value: String) -> KizunaSyncSelectBuilder {
    do {
      return append(try KizunaSyncFilterClause.node(column: column, operator: op, value: value))
    } catch let clause as KizunaSyncFilterClause.Refusal {
      return refuse("filter(\"\(column)\", \"\(op)\", …): \(clause.reason)")
    } catch {
      return refuse("filter(\"\(column)\", \"\(op)\", …): \(error)")
    }
  }

  /// Refused when the read runs: there is no server transaction to roll back;
  /// local writes enter the outbox.
  @discardableResult public func dryRun() -> KizunaSyncSelectBuilder {
    refuse(KizunaSyncRefusal.dryRun)
  }

  /// Refused when the read runs: PostGIS output has no local representation.
  @discardableResult public func geojson() -> KizunaSyncSelectBuilder {
    refuse(KizunaSyncRefusal.geojson)
  }

  /// Refused when the read runs: EXPLAIN describes the server query planner.
  @discardableResult public func explain(
    analyze: Bool = false,
    verbose: Bool = false,
    settings: Bool = false,
    buffers: Bool = false,
    wal: Bool = false,
    format: String = "text"
  ) -> KizunaSyncSelectBuilder {
    refuse(KizunaSyncRefusal.explain)
  }

  /// Refused when the read runs: a local read sends no HTTP request.
  @discardableResult public func setHeader(name: String, value: String) -> KizunaSyncSelectBuilder {
    refuse(KizunaSyncRefusal.setHeader)
  }

  private func append(_ filter: [String: Any]) -> KizunaSyncSelectBuilder {
    filters.append(filter)
    return self
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
  private var maxAffectedRows: Int?
  private var refusal: String?

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
  /// unfiltered write would target the whole table, and `LOCAL_CONSTRAINT`
  /// when the filters match more rows than `maxAffected(_:)` allows.
  @discardableResult public func execute() async throws -> [String] {
    try await run(options: [:])
  }

  /// The write with the kernel options its terminal adds.
  func run(options: [String: Any]) async throws -> [String] {
    if let refusal {
      throw KizunaSyncError.engine(code: KizunaSyncErrorCode.localUnsupported, message: refusal)
    }
    var options = options
    if let maxAffectedRows {
      options["max_affected"] = maxAffectedRows
    }
    return try await client.applyWhere(
      table: table,
      op: op,
      filters: filters,
      columns: columns,
      transforms: transforms,
      precondition: precondition,
      options: options
    )
  }

  private func refuse(_ message: String) -> KizunaSyncWriteBuilder {
    refusal = refusal ?? message
    return self
  }

  private func append(_ filter: [String: Any]) -> KizunaSyncWriteBuilder {
    filters.append(filter)
    return self
  }
}

// MARK: - Write operators

extension KizunaSyncWriteBuilder {
  /// Target the rows whose column matches the regular expression, Postgres `~`.
  @discardableResult public func match(_ column: String, pattern: String) -> KizunaSyncWriteBuilder {
    append(KizunaSyncOperatorNode.regex(column, pattern, caseInsensitive: false))
  }

  /// Case-insensitive `match(_:pattern:)`, Postgres `~*`.
  @discardableResult public func imatch(_ column: String, pattern: String) -> KizunaSyncWriteBuilder {
    append(KizunaSyncOperatorNode.regex(column, pattern, caseInsensitive: true))
  }

  /// Target the rows whose columns equal every value in `query`. An empty
  /// dictionary names no rows, so the write refuses it.
  @discardableResult public func match(_ query: [String: Any?]) -> KizunaSyncWriteBuilder {
    append(KizunaSyncOperatorNode.match(query))
  }

  /// Target the rows whose column matches every `like` pattern.
  @discardableResult public func likeAllOf(_ column: String, patterns: [String]) -> KizunaSyncWriteBuilder {
    append(KizunaSyncOperatorNode.patterns("like", column, patterns, any: false))
  }

  /// Target the rows whose column matches any `like` pattern.
  @discardableResult public func likeAnyOf(_ column: String, patterns: [String]) -> KizunaSyncWriteBuilder {
    append(KizunaSyncOperatorNode.patterns("like", column, patterns, any: true))
  }

  /// Case-insensitive `likeAllOf(_:patterns:)`.
  @discardableResult public func iLikeAllOf(_ column: String, patterns: [String]) -> KizunaSyncWriteBuilder {
    append(KizunaSyncOperatorNode.patterns("ilike", column, patterns, any: false))
  }

  /// Case-insensitive `likeAnyOf(_:patterns:)`.
  @discardableResult public func iLikeAnyOf(_ column: String, patterns: [String]) -> KizunaSyncWriteBuilder {
    append(KizunaSyncOperatorNode.patterns("ilike", column, patterns, any: true))
  }

  /// Target the rows whose column is distinct from `value`, SQL `IS DISTINCT FROM`.
  @discardableResult public func isDistinct(_ column: String, value: Any?) -> KizunaSyncWriteBuilder {
    append(KizunaSyncOperatorNode.isDistinct(column, value))
  }

  /// Target the rows whose column is none of `values`, SQL `NOT IN`.
  @discardableResult public func notIn(_ column: String, values: [Any?]) -> KizunaSyncWriteBuilder {
    append(KizunaSyncOperatorNode.notIn(column, values))
  }

  /// Target the rows whose array column shares an element with `value`, Postgres `&&`.
  @discardableResult public func overlaps(_ column: String, value: [Any?]) -> KizunaSyncWriteBuilder {
    append(KizunaSyncOperatorNode.overlaps(column, value))
  }

  /// Target the rows one PostgREST clause, `column.operator.value`, selects,
  /// with the grammar the read builder's `filter(_:operator:value:)` takes.
  @discardableResult public func filter(_ column: String, operator op: String, value: String) -> KizunaSyncWriteBuilder {
    do {
      return append(try KizunaSyncFilterClause.node(column: column, operator: op, value: value))
    } catch let clause as KizunaSyncFilterClause.Refusal {
      return refuse("filter(\"\(column)\", \"\(op)\", …): \(clause.reason)")
    } catch {
      return refuse("filter(\"\(column)\", \"\(op)\", …): \(error)")
    }
  }

  /// The most rows the write may reach. When the filters match more, nothing
  /// is written and the write throws `LOCAL_CONSTRAINT` naming the match count
  /// and the cap. A value outside 0 through 4294967295 throws
  /// `LOCAL_UNSUPPORTED` when the write runs.
  @discardableResult public func maxAffected(_ value: Int) -> KizunaSyncWriteBuilder {
    guard value >= 0, value <= Int(UInt32.max) else {
      return refuse("maxAffected(\(value)): the cap must be a whole number from 0 to \(UInt32.max)")
    }
    maxAffectedRows = value
    return self
  }

  /// Identity: a local write makes no network attempt to retry.
  @discardableResult public func retry(enabled: Bool) -> KizunaSyncWriteBuilder {
    self
  }

  /// Refused when the write runs: there is no server transaction to roll
  /// back; local writes enter the outbox.
  @discardableResult public func dryRun() -> KizunaSyncWriteBuilder {
    refuse(KizunaSyncRefusal.dryRun)
  }

  /// Refused when the write runs: PostGIS output has no local representation.
  @discardableResult public func geojson() -> KizunaSyncWriteBuilder {
    refuse(KizunaSyncRefusal.geojson)
  }

  /// Refused when the write runs: EXPLAIN describes the server query planner.
  @discardableResult public func explain(
    analyze: Bool = false,
    verbose: Bool = false,
    settings: Bool = false,
    buffers: Bool = false,
    wal: Bool = false,
    format: String = "text"
  ) -> KizunaSyncWriteBuilder {
    refuse(KizunaSyncRefusal.explain)
  }

  /// Refused when the write runs: a local write sends no HTTP request.
  @discardableResult public func setHeader(name: String, value: String) -> KizunaSyncWriteBuilder {
    refuse(KizunaSyncRefusal.setHeader)
  }

  /// Return the rows the write reaches, cut to `columns`: an update's as they
  /// read after it, a delete's as they read before it. A relational embed or
  /// a rename in `columns` throws `LOCAL_UNSUPPORTED` before anything is
  /// written.
  public func select(_ columns: String = "*") -> KizunaSyncWriteSelectBuilder {
    let returned = KizunaSyncRowShaping.returnedColumns(columns)
    if let refusal = returned.refusal {
      _ = refuse(refusal)
    }
    return KizunaSyncWriteSelectBuilder(write: self, columns: returned.columns)
  }
}

/// An update or a delete chained with `select(_:)`.
public final class KizunaSyncWriteSelectBuilder: @unchecked Sendable {
  private let write: KizunaSyncWriteBuilder
  private let columns: [String]?
  private var isStrippingNulls = false

  init(write: KizunaSyncWriteBuilder, columns: [String]?) {
    self.write = write
    self.columns = columns
  }

  /// Answer each returned row without its null-valued keys.
  @discardableResult public func stripNulls() -> KizunaSyncWriteSelectBuilder {
    isStrippingNulls = true
    return self
  }

  /// Identity: a local write makes no network attempt to retry.
  @discardableResult public func retry(enabled: Bool) -> KizunaSyncWriteSelectBuilder {
    self
  }

  /// Run the write and answer with the rows it reached, in primary-key order.
  public func execute() async throws -> Any {
    try await rows(options: ["returning": true])
  }

  /// Run the write and answer with its one row. A write whose filters match
  /// another count writes nothing and throws `LOCAL_CONSTRAINT` with the
  /// message a read gives, `single() requires exactly one row; got N`.
  public func single() async throws -> Any {
    try await rows(options: ["returning": true, "cardinality": "single"]).first ?? NSNull()
  }

  /// Run the write and answer with its row, or null when none matched. A
  /// write whose filters match more than one row writes nothing and throws
  /// `LOCAL_CONSTRAINT`.
  public func maybeSingle() async throws -> Any {
    try await rows(options: ["returning": true, "cardinality": "maybeSingle"]).first ?? NSNull()
  }

  private func rows(options: [String: Any]) async throws -> [[String: Any]] {
    let raw = try await write.run(options: options)
    return try raw.map { json in
      guard let row = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else {
        throw KizunaSyncError.engine(
          code: KizunaSyncErrorCode.engineUnavailable,
          message: "applyWhere: unreadable row"
        )
      }
      let projected = KizunaSyncRowShaping.project(row, columns)
      return isStrippingNulls ? projected.filter { !($0.value is NSNull) } : projected
    }
  }
}

/// The filter nodes the operators past the core set build; the core ones come
/// from `KizunaSyncQuery`.
enum KizunaSyncOperatorNode {
  static func regex(_ column: String, _ pattern: String, caseInsensitive: Bool) -> [String: Any] {
    ["kind": caseInsensitive ? "regexIMatch" : "regexMatch", "column": column, "pattern": pattern]
  }

  /// `eq` on every key, sorted so the node does not depend on dictionary order.
  static func match(_ query: [String: Any?]) -> [String: Any] {
    let equalities = query.keys.sorted().map { key in
      KizunaSyncQuery.eq(key, query[key].flatMap { $0 } ?? NSNull())
    }
    return KizunaSyncQuery.and(equalities)
  }

  static func patterns(_ kind: String, _ column: String, _ patterns: [String], any: Bool) -> [String: Any] {
    let nodes: [[String: Any]] = patterns.map { ["kind": kind, "column": column, "pattern": $0] }
    return any ? KizunaSyncQuery.or(nodes) : KizunaSyncQuery.and(nodes)
  }

  static func isDistinct(_ column: String, _ value: Any?) -> [String: Any] {
    ["kind": "isDistinct", "column": column, "value": value ?? NSNull()]
  }

  static func notIn(_ column: String, _ values: [Any?]) -> [String: Any] {
    KizunaSyncQuery.not(KizunaSyncQuery.`in`(column, values.map { $0 ?? NSNull() }))
  }

  static func overlaps(_ column: String, _ values: [Any?]) -> [String: Any] {
    ["kind": "overlaps", "column": column, "value": values.map { $0 ?? NSNull() }]
  }
}

/// Why each supabase-swift method with no local meaning is refused.
enum KizunaSyncRefusal {
  static let dryRun = "dryRun(): there is no server transaction to roll back; local writes enter the outbox"
  static let geojson = "geojson(): PostGIS output has no local representation"
  static let explain = "explain(): EXPLAIN describes the server query planner"
  static let setHeader = "setHeader(name:value:): a local read or write sends no HTTP request"
}

#endif
