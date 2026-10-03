import Foundation
import KizunaSyncFfi
import KizunaSyncScenarioSupport

/// Thin adapter: shared scenario runner → UniFFI-generated `KizunaSyncEngine`.
///
/// The only language-specific logic is JSON string marshalling and mapping the
/// generated error onto the runner's coded one; every assertion lives in
/// `KizunaSyncScenarioRunner`, shared with the host path.
final class GeneratedEngineAdapter: KizunaSyncScenarioEngine {
  private let engine = KizunaSyncFfi.KizunaSyncEngine()

  func create(config: [String: Any]) throws {
    var config = config
    if config["remote"] == nil {
      /**
       * The packaging build (the `http`-featured engine this binding links)
       * refuses a `create` config without a `remote`. The shared scenario oracle
       * carries none, since the same corpus also replays against lanes that run
       * an offline scripted remote. A build without `http` refuses any `remote`.
       * The scenarios set no token, so a sync stops at `AUTH_SESSION_MISSING`
       * before any request reaches the placeholder.
       */
      config["remote"] = ["url": "https://127.0.0.1:1", "publishable_key": "pub-xxx"]
    }
    try coded { try engine.create(configJson: Self.jsonString(config)) }
  }

  func apply(mutation: [String: Any]) throws {
    try coded { try engine.apply(mutationJson: Self.jsonString(mutation)) }
  }

  func query(request: [String: Any]) throws -> Any {
    let raw = try coded { try engine.query(reqJson: Self.jsonString(request)) }
    return try JSONSerialization.jsonObject(
      with: Data(raw.utf8),
      options: [.fragmentsAllowed]
    )
  }

  func sync() throws {
    try coded { try engine.sync() }
  }

  func outboxDepth() throws -> Int {
    Int(try coded { try engine.outboxDepth() })
  }

  func invoke(method: String, params: [String: Any]) throws -> Any {
    let raw = try coded { try engine.call(method: method, paramsJson: Self.jsonString(params)) }
    let object = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
    if object?["ok"] as? Bool == true {
      return object?["value"] ?? NSNull()
    }
    let failure = object?["error"] as? [String: Any]
    guard let code = failure?["code"] as? String else {
      // Every refusal the engine encodes carries a code; one without it is an
      // envelope this adapter does not understand, not a gradeable failure.
      throw KizunaSyncScenarioError.scenario("call(\(method)) answered without an error code: \(raw)")
    }
    throw KizunaSyncScenarioError.engine(
      code: code,
      message: failure?["message"] as? String ?? "call failed"
    )
  }

  /// Carries the engine's catalog code out of the generated error, so a step
  /// with `expect_code` grades the discriminant rather than the message.
  private func coded<T>(_ body: () throws -> T) throws -> T {
    do {
      return try body()
    } catch let error as KizunaSyncFfiError {
      switch error {
      case .Engine(let code, let msg):
        throw KizunaSyncScenarioError.engine(code: code, message: msg)
      }
    }
  }

  private static func jsonString(_ object: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: []),
          let text = String(data: data, encoding: .utf8)
    else {
      // Scenario payloads are plain JSON; an unencodable one is a test-data bug.
      return "{}"
    }
    return text
  }
}
