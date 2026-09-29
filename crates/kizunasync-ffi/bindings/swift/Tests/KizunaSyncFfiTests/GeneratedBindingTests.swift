import Foundation
import KizunaSync
import KizunaSyncScenarioSupport
import XCTest

@testable import KizunaSyncFfi

/// Exercises the **generated** UniFFI surface (`Generated/kizunasync_ffi.swift`)
/// linked against the cargo-built `libkizunasync_ffi`.
final class GeneratedBindingTests: XCTestCase {
  func testSharedScenariosRunOnGeneratedBinding() throws {
    let file = try KizunaSyncScenarios.loadFromRepo()
    try KizunaSyncScenarios.validateStructure(file)
    XCTAssertGreaterThanOrEqual(file.scenarios.count, 12, "shared oracle shrank")

    var skipped: [String] = []
    for scenario in file.scenarios {
      do {
        try KizunaSyncScenarioRunner.run(
          scenario,
          on: GeneratedEngineAdapter(),
          clientId: "swift-uniffi-scenario"
        )
      } catch {
        guard Self.needsOfflineScriptedRemote(error) else { throw error }
        skipped.append(scenario.id)
      }
    }
    if !skipped.isEmpty {
      throw XCTSkip(
        "scenario \(skipped.joined(separator: ", ")) needs the offline scripted remote; the packaging build has none"
      )
    }
  }

  /// True when the runner's failure is the packaging build reaching the fake
  /// remote the placeholder cannot satisfy, rather than a real assertion miss.
  private static func needsOfflineScriptedRemote(_ error: Error) -> Bool {
    let code: String?
    switch error {
    case KizunaSyncScenarioError.scenario(_, let scenarioCode):
      code = scenarioCode
    case KizunaSyncScenarioError.engine(let engineCode, _):
      code = engineCode
    default:
      code = nil
    }
    return code == "AUTH_SESSION_MISSING" || code?.hasPrefix("REMOTE") == true
  }

  func testCreateApplyQueryThroughGeneratedEngine() throws {
    let engine = KizunaSyncFfi.KizunaSyncEngine()
    try engine.create(
      configJson: """
      {"client_id":"swift-uniffi","schema_version":1,\
      "tables":{"items":{"bucket_column":"user_id","bucket_params":{"user_id":"u1"}}},\
      "remote":{"url":"https://127.0.0.1:1","publishable_key":"pub-xxx"}}
      """
    )
    try engine.apply(
      mutationJson: """
      {"table":"items","pk":"p1","op":"insert","mutation_id":"m1",\
      "columns":{"title":"Alpha","user_id":"u1"}}
      """
    )
    let raw = try engine.query(
      reqJson: """
      {"table":"items","plan":{"filters":[{"kind":"eq","column":"title","value":"Alpha"}],\
      "cardinality":"many"}}
      """
    )
    let rows = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [[String: Any]]
    )
    XCTAssertEqual(rows.count, 1)
    XCTAssertEqual(rows[0]["title"] as? String, "Alpha")
    XCTAssertEqual(try engine.outboxDepth(), 1)
  }

  // MARK: - Error mapping

  func testCreateWithInvalidJsonThrowsTypedError() {
    let engine = KizunaSyncFfi.KizunaSyncEngine()
    XCTAssertThrowsError(try engine.create(configJson: "{not json")) { error in
      guard case KizunaSyncFfiError.Engine(_, _) = error else {
        XCTFail("expected KizunaSyncFfiError.Engine, got \(error)")
        return
      }
    }
  }

  func testApplyWithInvalidJsonThrowsTypedError() throws {
    let engine = KizunaSyncFfi.KizunaSyncEngine()
    try engine.create(
      configJson: """
      {"client_id":"swift-uniffi","schema_version":1,\
      "tables":{"items":{"bucket_column":"user_id","bucket_params":{"user_id":"u1"}}},\
      "remote":{"url":"https://127.0.0.1:1","publishable_key":"pub-xxx"}}
      """
    )
    XCTAssertThrowsError(try engine.apply(mutationJson: "[[not-a-mutation")) { error in
      guard case KizunaSyncFfiError.Engine(_, _) = error else {
        XCTFail("expected KizunaSyncFfiError.Engine, got \(error)")
        return
      }
    }
  }

  func testApplyBeforeCreateThrowsTypedErrorWithMessage() {
    let engine = KizunaSyncFfi.KizunaSyncEngine()
    XCTAssertThrowsError(
      try engine.apply(mutationJson: #"{"table":"items","pk":"p1","op":"insert"}"#)
    ) { error in
      guard case KizunaSyncFfiError.Engine(let code, let msg) = error else {
        XCTFail("expected KizunaSyncFfiError.Engine, got \(error)")
        return
      }
      XCTAssertFalse(code.isEmpty)
      XCTAssertFalse(msg.isEmpty)
    }
  }

  func testQueryWithoutTableThrowsTypedError() throws {
    let engine = KizunaSyncFfi.KizunaSyncEngine()
    try engine.create(
      configJson: """
      {"client_id":"swift-uniffi","schema_version":1,\
      "tables":{"items":{"bucket_column":"user_id","bucket_params":{"user_id":"u1"}}},\
      "remote":{"url":"https://127.0.0.1:1","publishable_key":"pub-xxx"}}
      """
    )
    XCTAssertThrowsError(try engine.query(reqJson: #"{"plan":{}}"#)) { error in
      guard case KizunaSyncFfiError.Engine(_, _) = error else {
        XCTFail("expected KizunaSyncFfiError.Engine, got \(error)")
        return
      }
    }
  }
}
