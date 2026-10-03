import Foundation
import KizunaSync
import XCTest

#if canImport(KizunaSyncFfi)
import KizunaSyncFfi

/**
 * Answers `inspect()` with a JSON array, so the client's decode refuses the
 * payload instead of the engine refusing the call.
 */
private final class NonObjectInspectEngine: KizunaSyncFfi.KizunaSyncEngine, @unchecked Sendable {
  init() {
    super.init(noHandle: KizunaSyncFfi.KizunaSyncEngine.NoHandle())
  }

  required init(unsafeFromHandle handle: UInt64) {
    fatalError("NonObjectInspectEngine is never lifted from a handle")
  }

  override func inspect() throws -> String {
    "[1, 2]"
  }
}

/**
 * Answers every call with the same bytes, so the client's decode meets a
 * payload the bridge would never send.
 */
private final class GarbledEngine: KizunaSyncFfi.KizunaSyncEngine, @unchecked Sendable {
  private let payload: String

  init(payload: String) {
    self.payload = payload
    super.init(noHandle: KizunaSyncFfi.KizunaSyncEngine.NoHandle())
  }

  required init(unsafeFromHandle handle: UInt64) {
    fatalError("GarbledEngine is never lifted from a handle")
  }

  override func call(method: String, paramsJson: String) throws -> String {
    payload
  }

  override func inspect() throws -> String {
    payload
  }

  override func queryTable(table: String, planJson: String) throws -> String {
    payload
  }
}

/**
 * Raises one engine failure without a Rust engine behind it, so the mapping is
 * tested rather than the engine's own verdict.
 */
private final class FailingEngine: KizunaSyncFfi.KizunaSyncEngine, @unchecked Sendable {
  private let code: String
  private let msg: String

  init(code: String, msg: String) {
    self.code = code
    self.msg = msg
    super.init(noHandle: KizunaSyncFfi.KizunaSyncEngine.NoHandle())
  }

  required init(unsafeFromHandle handle: UInt64) {
    fatalError("FailingEngine is never lifted from a handle")
  }

  override func queryTable(table: String, planJson: String) throws -> String {
    throw KizunaSyncFfiError.Engine(code: code, msg: msg)
  }

  override func sync() throws {
    throw KizunaSyncFfiError.Engine(code: code, msg: msg)
  }
}

/**
 * The code every failure carries, engine and host alike. Two host conditions
 * the type documents are unreachable through the public API and have no test:
 * `CONFIG_INVALID` / `config is not utf8` and `ENGINE_UNAVAILABLE` /
 * `payload is not utf8` both need `JSONSerialization` to emit bytes outside
 * UTF-8, which it never does.
 */
final class KizunaSyncClientErrorTests: XCTestCase {
  func testLocalizedDescriptionCarriesTheCodeAndMessage() {
    let error = KizunaSyncError.engine(code: "X", message: "y")
    XCTAssertEqual((error as NSError).localizedDescription, "X: y")
  }

  func testEngineFailureCarriesTheCodeAsAField() async {
    let client = KizunaSyncClient(engine: FailingEngine(code: "UNKNOWN_TABLE", msg: "no such table"))
    do {
      _ = try await client.query(table: "todos")
      XCTFail("expected the engine failure to surface")
    } catch {
      XCTAssertEqual(error as? KizunaSyncError, .engine(code: "UNKNOWN_TABLE", message: "no such table"))
      XCTAssertEqual((error as? KizunaSyncError)?.code, "UNKNOWN_TABLE")
      XCTAssertEqual((error as? KizunaSyncError)?.message, "no such table")
      XCTAssertEqual(String(describing: error), "UNKNOWN_TABLE: no such table")
    }
  }

  func testEveryCallSiteMapsTheSameWay() async {
    let client = KizunaSyncClient(engine: FailingEngine(code: "ENGINE_UNAVAILABLE", msg: "not created"))
    do {
      try await client.sync()
      XCTFail("expected the engine failure to surface")
    } catch {
      XCTAssertEqual(
        error as? KizunaSyncError,
        .engine(code: "ENGINE_UNAVAILABLE", message: "not created")
      )
    }
  }

  func testAttachmentPortsMissingIsAKizunaSyncError() async {
    let client = KizunaSyncClient(engine: KizunaSyncFfi.KizunaSyncEngine(noHandle: KizunaSyncFfi.KizunaSyncEngine.NoHandle()))
    let config = KizunaSyncClientConfig(
      clientId: kizunasyncTestClientId,
      tables: [
        "items": KizunaSyncTableConfig(
          attachments: ["image": KizunaSyncAttachmentSpec(storageBucket: "media", ownerColumn: "user_id")]
        ),
      ]
    )
    do {
      try await client.create(config)
      XCTFail("expected ATTACHMENT_PORTS_MISSING")
    } catch {
      XCTAssertEqual((error as? KizunaSyncError)?.code, "ATTACHMENT_PORTS_MISSING")
      XCTAssertEqual(
        String(describing: error),
        "ATTACHMENT_PORTS_MISSING: a table declares attachments but attachmentRoot is unset"
      )
    }
  }

  func testAnUndecodableInspectPayloadIsEngineUnavailable() async {
    let client = KizunaSyncClient(engine: NonObjectInspectEngine())
    do {
      _ = try await client.inspect()
      XCTFail("expected the payload to be refused")
    } catch {
      XCTAssertEqual(
        error as? KizunaSyncError,
        .engine(code: "ENGINE_UNAVAILABLE", message: "inspect: expected an object")
      )
    }
  }

  func testAnUnreadableEnvelopeIsEngineUnavailable() async {
    for payload in ["not json", "[1, 2]"] {
      let client = KizunaSyncClient(engine: GarbledEngine(payload: payload))
      do {
        _ = try await client.overwrites()
        XCTFail("expected the envelope \(payload) to be refused")
      } catch {
        XCTAssertEqual(
          error as? KizunaSyncError,
          .engine(code: "ENGINE_UNAVAILABLE", message: "overwrites: unreadable envelope")
        )
      }
    }
  }

  func testAnUnparseableInspectPayloadIsEngineUnavailable() async {
    let client = KizunaSyncClient(engine: GarbledEngine(payload: "not json"))
    do {
      _ = try await client.inspect()
      XCTFail("expected the payload to be refused")
    } catch {
      XCTAssertEqual(
        error as? KizunaSyncError,
        .engine(code: "ENGINE_UNAVAILABLE", message: "inspect: expected an object")
      )
    }
  }

  func testAnUnparseableQueryPayloadIsEngineUnavailable() async {
    let client = KizunaSyncClient(engine: GarbledEngine(payload: "not json"))
    do {
      _ = try await client.query(table: "todos")
      XCTFail("expected the payload to be refused")
    } catch {
      XCTAssertEqual(
        error as? KizunaSyncError,
        .engine(code: "ENGINE_UNAVAILABLE", message: "query: unreadable payload")
      )
    }
  }

  func testAHostCheckCarriesACatalogCodeToo() async {
    let client = KizunaSyncClient(engine: KizunaSyncFfi.KizunaSyncEngine(noHandle: KizunaSyncFfi.KizunaSyncEngine.NoHandle()))
    do {
      try await client.apply(table: "", pk: "", op: .insert)
      XCTFail("expected the host check to refuse")
    } catch {
      XCTAssertEqual((error as? KizunaSyncError)?.code, "LOCAL_UNSUPPORTED")
      XCTAssertEqual(String(describing: error), "LOCAL_UNSUPPORTED: apply requires table and pk")
    }
  }
}

#endif
