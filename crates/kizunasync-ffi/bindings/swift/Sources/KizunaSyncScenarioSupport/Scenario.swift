import Foundation

// MARK: - Shared scenarios

/// The whole oracle file: a version and its scenarios.
public struct ScenarioFile: Codable {
  /// The oracle's format version.
  public let version: Int
  /// Every scenario the file holds.
  public let scenarios: [Scenario]
}

/// One scenario: an ordered list of steps over one engine.
public struct Scenario: Codable {
  /// Stable identifier, unique across the file.
  public let id: String
  /// What the scenario pins, in one sentence.
  public let description: String
  /// The steps, executed in order against one engine.
  public let steps: [ScenarioStep]
}

/// One step. Every field beyond `op` belongs to a subset of the operations.
public struct ScenarioStep: Codable {
  /// Which operation to run.
  public let op: String
  /// The table the operation addresses.
  public let table: String?
  /// The row's primary key.
  public let pk: String?
  /// The write operation a mutation carries.
  public let mutation_op: String?
  /// The mutation's identifier; the step index is used when it is absent.
  public let mutation_id: String?
  /// The columns a mutation writes.
  public let columns: [String: JSONValue]?
  /// The transforms a mutation applies.
  public let transforms: [String: JSONValue]?
  /// The precondition a mutation carries.
  public let precondition: [String: JSONValue]?
  /// The filters a filter-targeted write matches on.
  public let filters: [JSONValue]?
  /// The bucket parameters `set_bucket` binds.
  public let params: [String: JSONValue]?
  /// The durable queue row `attachment_put` enqueues, verbatim.
  public let attachment: [String: JSONValue]?
  /// The mutable columns `attachment_patch` writes.
  public let patch: [String: JSONValue]?
  /// Which side of the attachment queue the step reads, `upload` or `download`.
  public let direction: String?
  /// The attachment reference the step addresses.
  public let reference: String?
  /// The cursor `seed_checkpoint` adopts.
  public let cursor: String?
  /// Whether `rejections` includes the dismissed ones.
  public let include_dismissed: Bool?
  /// The query plan.
  public let plan: JSONValue?
  /// The table declarations `create` takes.
  public let tables: [String: JSONValue]?
  /// How many rows the step expects back.
  public let expect_count: Int?
  /// The title of the one row the step expects back.
  public let expect_single_title: String?
  /// Whether the step expects a null answer.
  public let expect_null: Bool?
  /// Whether the step expects the operation to fail.
  public let expect_error: Bool?
  /// The outbox depth the step expects.
  public let expect_depth: Int?
  /// The cursor the step expects.
  public let expect_cursor: String?
  /// The catalog code the step expects the failure to carry.
  public let expect_code: String?
  /// The ordered column values the step expects.
  public let expect_column_values: ExpectColumnValues?
  /// The answered value the step expects, whole.
  public let expect_value: JSONValue?
  /// The attachment-status keys the step expects, as a subset: the rest of a
  /// status is the engine's to choose.
  public let expect_status: [String: JSONValue]?
}

/// Ordered projection of one column across the returned rows.
public struct ExpectColumnValues: Codable {
  /// The column to read from every row.
  public let column: String
  /// The values, in row order.
  public let values: [JSONValue]
}

/// Minimal JSON value for Codable scenario payloads.
public enum JSONValue: Codable, Equatable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case object([String: JSONValue])
  case array([JSONValue])
  case null

  /// Decode any JSON scalar, object, or array.
  ///
  /// Throws `KizunaSyncScenarioError.scenario` for a value outside that set.
  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null; return }
    if let v = try? c.decode(Bool.self) { self = .bool(v); return }
    if let v = try? c.decode(Double.self) { self = .number(v); return }
    if let v = try? c.decode(String.self) { self = .string(v); return }
    if let v = try? c.decode([String: JSONValue].self) { self = .object(v); return }
    if let v = try? c.decode([JSONValue].self) { self = .array(v); return }
    throw KizunaSyncScenarioError.scenario("unsupported json")
  }

  /// Encode back to the same JSON shape.
  ///
  /// Throws whatever the encoder reports.
  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .string(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .bool(let v): try c.encode(v)
    case .object(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .null: try c.encodeNil()
    }
  }

  /// The value as the `Any` tree `JSONSerialization` takes.
  public var anyObject: Any {
    switch self {
    case .string(let v): return v
    case .number(let v): return v
    case .bool(let v): return v
    case .object(let v): return v.mapValues { $0.anyObject }
    case .array(let v): return v.map { $0.anyObject }
    case .null: return NSNull()
    }
  }
}

/// Loading and structural validation of the shared oracle.
public enum KizunaSyncScenarios {
  /// Monorepo-relative location of the single cross-language oracle.
  public static let repoRelativePath = "crates/kizunasync-scenarios/scenarios.json"

  /// Read and decode the oracle at `url`.
  ///
  /// Throws whatever the reader or the decoder reports.
  public static func load(from url: URL) throws -> ScenarioFile {
    let data = try Data(contentsOf: url)
    return try JSONDecoder().decode(ScenarioFile.self, from: data)
  }

  /// Walk up from the working directory and this source file to find the shared
  /// scenarios. Fails loud rather than falling back to an embedded copy that
  /// could silently under-test the bindings.
  ///
  /// Throws `KizunaSyncScenarioError.scenario` when no repository root holds the file.
  public static func loadFromRepo(
    file: String = #filePath,
    cwd: String = FileManager.default.currentDirectoryPath
  ) throws -> ScenarioFile {
    var roots: [URL] = [URL(fileURLWithPath: cwd)]
    var dir = URL(fileURLWithPath: file).deletingLastPathComponent()
    for _ in 0..<12 {
      roots.append(dir)
      let parent = dir.deletingLastPathComponent()
      if parent.path == dir.path { break }
      dir = parent
    }
    for root in roots {
      let found = root.appendingPathComponent(repoRelativePath)
      if FileManager.default.fileExists(atPath: found.path) {
        return try load(from: found)
      }
    }
    throw KizunaSyncScenarioError.scenario("\(repoRelativePath) not found from \(cwd)")
  }

  /// Assert the oracle's shape: a known version, at least one scenario, and an
  /// identifier and steps on each.
  ///
  /// Throws `KizunaSyncScenarioError.scenario` naming the first violation.
  public static func validateStructure(_ file: ScenarioFile) throws {
    guard file.version >= 1 else { throw KizunaSyncScenarioError.scenario("bad version") }
    guard !file.scenarios.isEmpty else { throw KizunaSyncScenarioError.scenario("no scenarios") }
    for s in file.scenarios {
      guard !s.id.isEmpty else { throw KizunaSyncScenarioError.scenario("empty id") }
      guard !s.steps.isEmpty else { throw KizunaSyncScenarioError.scenario("empty steps for \(s.id)") }
    }
  }
}
