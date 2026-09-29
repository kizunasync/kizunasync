import Foundation

/// Errors raised by the shared scenario runner.
public enum KizunaSyncScenarioError: Error, Equatable {
  /**
   * An expectation the oracle states was not met, or a step's operation
   * failed without declaring `expect_error`. `code` carries the engine's own
   * catalog code when the wrapped failure was a `KizunaSyncScenarioError.engine`,
   * nil for a local failure the runner raised itself, so a caller can grade
   * the discriminant instead of parsing the rendered message.
   */
  case scenario(String, code: String? = nil)
  /// One engine failure, carrying the catalog code a step can grade.
  case engine(code: String, message: String)
}

// MARK: - Shared scenario runner

/**
 * Engine operations a scenario needs. The UniFFI-generated `KizunaSyncEngine` adapts
 * to this so the shared runner grades it against the same JSON oracle used by
 * the other language bindings. An adapter reports a failure as
 * `KizunaSyncScenarioError.engine`, so a step's `expect_code` grades the typed
 * discriminant and never the message text.
 */
public protocol KizunaSyncScenarioEngine: AnyObject {
  /// Open the store and declare the tables.
  func create(config: [String: Any]) throws
  /// Queue one mutation.
  func apply(mutation: [String: Any]) throws
  /// Run one query request.
  func query(request: [String: Any]) throws -> Any
  /// Pull then push once.
  func sync() throws
  /// How many mutations are queued.
  func outboxDepth() throws -> Int
  /// Any other engine method, through the JSON-RPC surface.
  func invoke(method: String, params: [String: Any]) throws -> Any
}

/// Executes the oracle's steps against one engine.
public enum KizunaSyncScenarioRunner {
  /// Execute every step of `scenario`, throwing `KizunaSyncScenarioError.scenario` on the
  /// first unmet expectation.
  ///
  /// Throws `KizunaSyncScenarioError.scenario` for an unmet expectation and whatever
  /// the engine reported for a step the oracle expects to succeed.
  public static func run(
    _ scenario: Scenario,
    on engine: KizunaSyncScenarioEngine,
    clientId: String
  ) throws {
    for (index, step) in scenario.steps.enumerated() {
      let ctx = "\(scenario.id)#\(index)"
      switch step.op {
      case "create":
        var config: [String: Any] = ["client_id": clientId, "schema_version": 1]
        if let tables = step.tables {
          config["tables"] = tables.mapValues { $0.anyObject }
        }
        try graded(step, ctx: ctx, op: "create") { try engine.create(config: config) }
      case "apply":
        try runApply(step, ctx: ctx, on: engine)
      case "query":
        try runQuery(step, ctx: ctx, on: engine)
      case "outbox_depth":
        try runOutboxDepth(step, ctx: ctx, on: engine)
      case "sync":
        try graded(step, ctx: ctx, op: "sync") { try engine.sync() }
      case "apply_where":
        _ = try invoke(step, ctx: ctx, on: engine, method: "apply_where", params: applyWhereParams(step))
      case "rejections":
        try runRejections(step, ctx: ctx, on: engine)
      case "checkpoint":
        try runCheckpoint(step, ctx: ctx, on: engine)
      case "seed_checkpoint":
        guard let cursor = step.cursor else {
          throw KizunaSyncScenarioError.scenario("\(ctx): cursor required")
        }
        _ = try invoke(step, ctx: ctx, on: engine, method: "seed_checkpoint", params: ["cursor": cursor])
      case "set_bucket":
        var params: [String: Any] = [:]
        if let bucket = step.params {
          params["params"] = bucket.mapValues { $0.anyObject }
        }
        _ = try invoke(step, ctx: ctx, on: engine, method: "set_bucket", params: params)
      case "attachment_put":
        guard let row = step.attachment else {
          throw KizunaSyncScenarioError.scenario("\(ctx): attachment required")
        }
        _ = try invoke(
          step, ctx: ctx, on: engine,
          method: "attachment_put",
          params: row.mapValues { $0.anyObject }
        )
      case "attachment_patch":
        let params: [String: Any] = [
          "reference": try reference(step, ctx: ctx),
          "patch": (step.patch ?? [:]).mapValues { $0.anyObject },
        ]
        _ = try invoke(step, ctx: ctx, on: engine, method: "attachment_patch", params: params)
      case "attachment_pending":
        try runAttachmentPending(step, ctx: ctx, on: engine)
      case "attachment_fail_next":
        try runAttachmentFailNext(step, ctx: ctx, on: engine)
      case "attachment_status", "attachment_retry", "attachment_cancel", "attachment_remove":
        try runAttachmentReference(step, ctx: ctx, on: engine, method: step.op)
      default:
        throw KizunaSyncScenarioError.scenario("\(ctx): unknown scenario op \(step.op)")
      }
    }
  }

  /**
   * Grade the failure a step expected. A step without `expect_code` pins only
   * that the operation failed; one with it pins the catalog code the adapter
   * carried out of the engine.
   */
  private static func assertExpectedFailure(
    _ step: ScenarioStep,
    ctx: String,
    error: Error
  ) throws {
    guard let expected = step.expect_code else { return }
    guard case KizunaSyncScenarioError.engine(let code, _) = error, code == expected else {
      throw KizunaSyncScenarioError.scenario(
        "\(ctx): expect_code \(expected), got \(String(describing: error))"
      )
    }
  }

  /**
   * Run one operation against the step's own expectation: a step that declares
   * `expect_error` asserts the refusal and its `expect_code`, and anything else
   * that fails is the engine breaking its own contract.
   */
  private static func graded(
    _ step: ScenarioStep,
    ctx: String,
    op: String,
    _ body: () throws -> Void
  ) throws {
    guard step.expect_error == true else {
      do {
        try body()
      } catch {
        throw KizunaSyncScenarioError.scenario("\(ctx): \(op) failed: \(error)", code: engineCode(error))
      }
      return
    }
    do {
      try body()
    } catch {
      try assertExpectedFailure(step, ctx: ctx, error: error)
      return
    }
    throw KizunaSyncScenarioError.scenario("\(ctx): expected \(op) to fail")
  }

  /**
   * One JSON-RPC call through a shared grader. A refused step answers nil.
   * Refusal is assertable on the two typed-surface calls and on `apply_where`,
   * `set_bucket`, and the attachment methods.
   */
  private static func invoke(
    _ step: ScenarioStep,
    ctx: String,
    on engine: KizunaSyncScenarioEngine,
    method: String,
    params: [String: Any]
  ) throws -> Any? {
    guard step.expect_error == true else {
      do {
        return try engine.invoke(method: method, params: params)
      } catch {
        throw KizunaSyncScenarioError.scenario("\(ctx): \(method) failed: \(error)", code: engineCode(error))
      }
    }
    do {
      _ = try engine.invoke(method: method, params: params)
    } catch {
      try assertExpectedFailure(step, ctx: ctx, error: error)
      return nil
    }
    throw KizunaSyncScenarioError.scenario("\(ctx): expected \(method) to fail")
  }

  /// A call the runner makes for its own bookkeeping rather than for the step,
  /// so no expectation of the step applies to it.
  private static func callOk(
    _ engine: KizunaSyncScenarioEngine,
    method: String,
    params: [String: Any]
  ) throws -> Any {
    try engine.invoke(method: method, params: params)
  }

  /// The engine's catalog code when `error` is `KizunaSyncScenarioError.engine`,
  /// nil for a local failure the runner raised itself.
  private static func engineCode(_ error: Error) -> String? {
    guard case KizunaSyncScenarioError.engine(let code, _) = error else { return nil }
    return code
  }

  private static func reference(_ step: ScenarioStep, ctx: String) throws -> String {
    guard let reference = step.reference else {
      throw KizunaSyncScenarioError.scenario("\(ctx): reference required")
    }
    return reference
  }

  /**
   * Compare the answered value against whatever the step named: `expect_value`
   * is the whole value, `expect_status` a subset of its keys, and `expect_null`
   * the absence of a row.
   */
  private static func assertAnswer(_ step: ScenarioStep, ctx: String, value: Any?) throws {
    if let expected = step.expect_value {
      guard sameJson(value, expected.anyObject) else {
        throw KizunaSyncScenarioError.scenario(
          "\(ctx): expect_value \(expected.anyObject), got \(String(describing: value))"
        )
      }
    }
    if step.expect_null == true, !isNull(value) {
      throw KizunaSyncScenarioError.scenario("\(ctx): expect_null, got \(String(describing: value))")
    }
    if let expected = step.expect_status {
      guard let status = value as? [String: Any] else {
        throw KizunaSyncScenarioError.scenario(
          "\(ctx): expect_status needs an object, got \(String(describing: value))"
        )
      }
      for (key, wanted) in expected {
        guard sameJson(status[key], wanted.anyObject) else {
          throw KizunaSyncScenarioError.scenario(
            "\(ctx): expect_status[\(key)] \(wanted.anyObject) in \(status)"
          )
        }
      }
    }
  }

  private static func isNull(_ value: Any?) -> Bool {
    value == nil || value is NSNull
  }

  /// Value equality over decoded JSON, which `NSArray` gives for scalars,
  /// objects and arrays alike without a type switch per shape.
  private static func sameJson(_ actual: Any?, _ expected: Any) -> Bool {
    NSArray(array: [actual ?? NSNull()]).isEqual(to: [expected])
  }

  private static func runOutboxDepth(
    _ step: ScenarioStep,
    ctx: String,
    on engine: KizunaSyncScenarioEngine
  ) throws {
    guard let expected = step.expect_depth else {
      throw KizunaSyncScenarioError.scenario("\(ctx): expect_depth required")
    }
    var depth = 0
    try graded(step, ctx: ctx, op: "outbox_depth") { depth = try engine.outboxDepth() }
    guard step.expect_error != true else { return }
    guard depth == expected else {
      throw KizunaSyncScenarioError.scenario("\(ctx): outbox depth \(expected), got \(depth)")
    }
  }

  /// The candidates one direction would drive next.
  private static func runAttachmentPending(
    _ step: ScenarioStep,
    ctx: String,
    on engine: KizunaSyncScenarioEngine
  ) throws {
    let params: [String: Any] = ["direction": step.direction ?? "upload"]
    guard let value = try invoke(
      step, ctx: ctx, on: engine,
      method: "attachment_pending",
      params: params
    ) else { return }
    guard let expected = step.expect_count else { return }
    guard let rows = value as? [Any], rows.count == expected else {
      throw KizunaSyncScenarioError.scenario(
        "\(ctx): expect_count \(expected), got \(String(describing: value))"
      )
    }
  }

  /// Every method that takes one reference and answers one value.
  private static func runAttachmentReference(
    _ step: ScenarioStep,
    ctx: String,
    on engine: KizunaSyncScenarioEngine,
    method: String
  ) throws {
    let params: [String: Any] = ["reference": try reference(step, ctx: ctx)]
    guard let value = try invoke(step, ctx: ctx, on: engine, method: method, params: params) else {
      return
    }
    try assertAnswer(step, ctx: ctx, value: value)
  }

  /**
   * One failed transfer attempt, recorded as a host queue records one: claim
   * the row, then write the attempt and the failure back. Runners attach no
   * transfer port; this stands in for real bytes failing. The step's
   * `expect_value` is the claim's own answer, pinning the attempt at which
   * the transfer budget stops claiming.
   */
  private static func runAttachmentFailNext(
    _ step: ScenarioStep,
    ctx: String,
    on engine: KizunaSyncScenarioEngine
  ) throws {
    let reference = try reference(step, ctx: ctx)
    let entry = try callOk(engine, method: "attachment_get", params: ["reference": reference])
    guard let row = entry as? [String: Any] else {
      throw KizunaSyncScenarioError.scenario("\(ctx): no attachment row carries \(reference)")
    }
    let running = row["direction"] as? String == "download" ? "downloading" : "uploading"
    let claimed = try callOk(
      engine,
      method: "attachment_claim",
      params: ["reference": reference, "state": running]
    )
    if claimed as? Bool == true {
      let attempts = (row["attempts"] as? Int ?? 0) + 1
      let patch: [String: Any] = [
        "state": "failed",
        "in_flight": false,
        "attempts": attempts,
        "error": "the scenario's transfer failed",
      ]
      _ = try callOk(
        engine,
        method: "attachment_patch",
        params: ["reference": reference, "patch": patch]
      )
    }
    try assertAnswer(step, ctx: ctx, value: claimed)
  }

  private static func runApply(
    _ step: ScenarioStep,
    ctx: String,
    on engine: KizunaSyncScenarioEngine
  ) throws {
    var mutation: [String: Any] = [
      "table": step.table ?? "",
      "pk": step.pk ?? "",
      "op": step.mutation_op ?? "insert",
      "mutation_id": step.mutation_id ?? ctx,
    ]
    if let columns = step.columns {
      mutation["columns"] = columns.mapValues { $0.anyObject }
    }
    if let transforms = step.transforms {
      mutation["transforms"] = transforms.mapValues { $0.anyObject }
    }
    if let precondition = step.precondition {
      mutation["precondition"] = precondition.mapValues { $0.anyObject }
    }
    if step.expect_error == true {
      do {
        try engine.apply(mutation: mutation)
      } catch {
        try assertExpectedFailure(step, ctx: ctx, error: error)
        return
      }
      throw KizunaSyncScenarioError.scenario("\(ctx): expected apply to fail")
    }
    try engine.apply(mutation: mutation)
  }

  private static func runQuery(
    _ step: ScenarioStep,
    ctx: String,
    on engine: KizunaSyncScenarioEngine
  ) throws {
    var request: [String: Any] = ["table": step.table ?? ""]
    if let plan = step.plan {
      request["plan"] = plan.anyObject
    }

    if step.expect_error == true {
      do {
        _ = try engine.query(request: request)
      } catch {
        try assertExpectedFailure(step, ctx: ctx, error: error)
        return
      }
      throw KizunaSyncScenarioError.scenario("\(ctx): expected query to fail")
    }

    let result = try engine.query(request: request)

    if let expected = step.expect_count {
      guard let rows = result as? [Any], rows.count == expected else {
        throw KizunaSyncScenarioError.scenario(
          "\(ctx): expect_count \(expected), got \(String(describing: result))"
        )
      }
    }
    if step.expect_null == true, !(result is NSNull) {
      throw KizunaSyncScenarioError.scenario("\(ctx): expect_null, got \(String(describing: result))")
    }
    if let title = step.expect_single_title {
      let row: [String: Any]?
      if let dict = result as? [String: Any] {
        row = dict
      } else if let rows = result as? [[String: Any]] {
        row = rows.first
      } else {
        row = nil
      }
      guard let actual = row?["title"] as? String, actual == title else {
        throw KizunaSyncScenarioError.scenario(
          "\(ctx): expect_single_title \(title), got \(String(describing: result))"
        )
      }
    }
    if let expected = step.expect_column_values {
      guard let rows = result as? [[String: Any]] else {
        throw KizunaSyncScenarioError.scenario(
          "\(ctx): expect_column_values needs rows, got \(String(describing: result))"
        )
      }
      let actual = rows.map { $0[expected.column] ?? NSNull() }
      let wanted = expected.values.map { $0.anyObject }
      guard NSArray(array: actual).isEqual(to: wanted) else {
        throw KizunaSyncScenarioError.scenario(
          "\(ctx): expect_column_values[\(expected.column)] \(wanted), got \(actual)"
        )
      }
    }
  }

  private static func applyWhereParams(_ step: ScenarioStep) -> [String: Any] {
    var params: [String: Any] = [
      "table": step.table ?? "",
      "op": step.mutation_op ?? "update",
    ]
    if let filters = step.filters {
      params["filters"] = filters.map { $0.anyObject }
    }
    if let columns = step.columns {
      params["columns"] = columns.mapValues { $0.anyObject }
    }
    if let transforms = step.transforms {
      params["transforms"] = transforms.mapValues { $0.anyObject }
    }
    return params
  }

  private static func runRejections(
    _ step: ScenarioStep,
    ctx: String,
    on engine: KizunaSyncScenarioEngine
  ) throws {
    guard let result = try invoke(
      step, ctx: ctx, on: engine,
      method: "rejections",
      params: ["include_dismissed": step.include_dismissed ?? false]
    ) else { return }
    if let expected = step.expect_count {
      let count: Int
      if let rows = result as? [Any] {
        count = rows.count
      } else {
        throw KizunaSyncScenarioError.scenario("\(ctx): rejections expected array, got \(result)")
      }
      guard count == expected else {
        throw KizunaSyncScenarioError.scenario("\(ctx): rejections count \(expected), got \(count)")
      }
    }
  }

  private static func runCheckpoint(
    _ step: ScenarioStep,
    ctx: String,
    on engine: KizunaSyncScenarioEngine
  ) throws {
    guard let result = try invoke(
      step, ctx: ctx, on: engine,
      method: "checkpoint",
      params: [:]
    ) else { return }
    guard let expected = step.expect_cursor else { return }
    let actual: String?
    if let cursor = result as? String {
      actual = cursor
    } else if let object = result as? [String: Any] {
      actual = object["cursor"] as? String
    } else {
      actual = nil
    }
    guard actual == expected else {
      throw KizunaSyncScenarioError.scenario("\(ctx): expect_cursor \(expected), got \(String(describing: result))")
    }
  }
}
