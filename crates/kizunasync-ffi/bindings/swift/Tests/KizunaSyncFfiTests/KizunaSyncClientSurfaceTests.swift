import Foundation
import KizunaSync
import XCTest

#if canImport(KizunaSyncFfi)

final class KizunaSyncClientSurfaceTests: XCTestCase {
  func testInspectFromAndDispose() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client()
    try await client.from("items").insert(["title": "one", "user_id": "u1", "id": "p1"])
    let rows = try await client.from("items").select().eq("id", "p1").execute()
    XCTAssertTrue(rows is [[String: Any]] || rows is [Any])
    let snapshot = try await client.inspect()
    XCTAssertEqual(snapshot["depth"] as? Int, 1)
    XCTAssertEqual(snapshot["cursor"] as? String, "0")
    await client.dispose()
    do {
      _ = try await client.outboxDepth()
      XCTFail("dispose must close the engine")
    } catch {
      XCTAssertNotNil((error as? KizunaSyncError)?.code)
    }
  }

  func testFromRefusesATableTheConfigNeverDeclared() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client()
    XCTAssertThrowsError(try client.from("ghosts")) { error in
      XCTAssertEqual((error as? KizunaSyncError)?.code, "UNKNOWN_TABLE")
      XCTAssertTrue(
        String(describing: error).contains("configured: items"),
        "the refusal names the configured tables, got \(error)"
      )
    }
  }

  func testWriteBuilderTargetsEveryOperator() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client()
    let table = try client.from("items")
    try await table.insert(["id": "p1", "title": "alpha", "user_id": "u1", "rank": 1, "done": false])
    try await table.insert(["id": "p2", "title": "beta", "user_id": "u1", "rank": 2, "done": false])
    try await table.insert(["id": "p3", "title": "gamma", "user_id": "u1", "rank": 3, "done": true])

    func targeted(_ name: String, _ rows: [String], _ expected: [String]) {
      XCTAssertEqual(rows.sorted(), expected, "\(name) targeted the wrong rows")
    }
    let assign: [String: Any] = ["title": "x"]

    targeted("eq", try await table.update(assign).eq("rank", 2).execute(), ["p2"])
    targeted("neq", try await table.update(assign).neq("rank", 2).execute(), ["p1", "p3"])
    targeted("gt", try await table.update(assign).gt("rank", 2).execute(), ["p3"])
    targeted("gte", try await table.update(assign).gte("rank", 2).execute(), ["p2", "p3"])
    targeted("lt", try await table.update(assign).lt("rank", 2).execute(), ["p1"])
    targeted("lte", try await table.update(assign).lte("rank", 2).execute(), ["p1", "p2"])
    targeted("like", try await table.update(assign).like("id", "p1").execute(), ["p1"])
    targeted("ilike", try await table.update(assign).ilike("id", "P1").execute(), ["p1"])
    targeted("is", try await table.update(assign).`is`("done", true).execute(), ["p3"])
    targeted("in", try await table.update(assign).`in`("id", ["p1", "p3"]).execute(), ["p1", "p3"])
    targeted("contains", try await table.update(assign).contains("id", "p2").execute(), ["p2"])
    targeted(
      "containedBy",
      try await table.update(assign).containedBy("id", "p2").execute(),
      ["p2"]
    )
    targeted(
      "or",
      try await table.update(assign)
        .or([KizunaSyncQuery.eq("id", "p1"), KizunaSyncQuery.eq("id", "p2")]).execute(),
      ["p1", "p2"]
    )
    targeted(
      "and",
      try await table.update(assign)
        .and([KizunaSyncQuery.eq("id", "p1"), KizunaSyncQuery.eq("done", false)]).execute(),
      ["p1"]
    )
    targeted(
      "not",
      try await table.update(assign).not(KizunaSyncQuery.eq("id", "p1")).execute(),
      ["p2", "p3"]
    )

    let deleted = try await table.delete().eq("id", "p3").execute()
    XCTAssertEqual(deleted, ["p3"])
  }

  func testAnUnfilteredWriteIsLocalUnsupported() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client()
    let table = try client.from("items")
    try await table.insert(["id": "p1", "title": "alpha", "user_id": "u1"])
    do {
      _ = try await table.update(["title": "x"]).execute()
      XCTFail("an unfiltered write must be refused")
    } catch {
      XCTAssertEqual((error as? KizunaSyncError)?.code, "LOCAL_UNSUPPORTED")
    }
  }

  func testCardinalityMissesAreLocalConstraint() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client()
    let table = try client.from("items")
    try await table.insert(["id": "p1", "title": "alpha", "user_id": "u1"])
    try await table.insert(["id": "p2", "title": "alpha", "user_id": "u1"])
    do {
      _ = try await table.select().eq("title", "absent").single()
      XCTFail("single() over zero rows must be refused")
    } catch {
      XCTAssertEqual((error as? KizunaSyncError)?.code, "LOCAL_CONSTRAINT")
    }
    do {
      _ = try await table.select().eq("title", "alpha").maybeSingle()
      XCTFail("maybeSingle() over two rows must be refused")
    } catch {
      XCTAssertEqual((error as? KizunaSyncError)?.code, "LOCAL_CONSTRAINT")
    }
  }

  func testAnEmbedProjectionIsLocalUnsupported() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client()
    let table = try client.from("items")
    try await table.insert(["id": "p1", "title": "alpha", "user_id": "u1"])
    do {
      _ = try await table.select("title, author(name)").execute()
      XCTFail("a relational embed must be refused")
    } catch {
      XCTAssertEqual((error as? KizunaSyncError)?.code, "LOCAL_UNSUPPORTED")
    }
  }

  func testAnEmptyProjectionSegmentIsDropped() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client()
    let table = try client.from("items")
    try await table.insert(["id": "p1", "title": "alpha", "user_id": "u1"])
    let rows = try await table.select("title,,user_id").execute() as? [[String: Any]]
    XCTAssertEqual(rows?.count, 1)
    XCTAssertEqual(rows?.first?.keys.sorted(), ["title", "user_id"])
  }

  func testANonStringIdOnInsertIsLocalConstraint() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client()
    do {
      try await client.from("items").insert(["id": 7, "title": "alpha", "user_id": "u1"])
      XCTFail("a non-string id must be refused, never replaced")
    } catch {
      XCTAssertEqual((error as? KizunaSyncError)?.code, "LOCAL_CONSTRAINT")
    }
  }

  func testAPullOnlyTableRefusesALocalWrite() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client(
      declaring: ["items": KizunaSyncTableConfig(bucket: .byColumn("user_id"), syncMode: .pullOnly)]
    )
    do {
      try await client.from("items").insert(["title": "alpha", "user_id": "u1"])
      XCTFail("a local write to a pull-only table must be refused")
    } catch {
      XCTAssertEqual((error as? KizunaSyncError)?.code, "LOCAL_UNSUPPORTED")
    }
    let depth = try await client.outboxDepth()
    XCTAssertEqual(depth, 0, "the refused write never reached the outbox")
    await client.dispose()
  }

  func testAnOwnerBucketTakesTheSessionUser() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client(declaring: ["items": KizunaSyncTableConfig(bucket: .byOwner("user_id"))])
    try await client.setAccessToken(kizunasyncTestToken(subject: kizunasyncTestOwner))
    try await client.from("items").insert(["id": kizunasyncTestRowId, "title": "works on a plane"])

    let rows = try await client.from("items").select().eq("id", kizunasyncTestRowId).execute() as? [[String: Any]]
    XCTAssertEqual(rows?.first?["user_id"] as? String, kizunasyncTestOwner, "the local row carries the session user")
    let queued = try await client.inspect()["queued"] as? [[String: Any]]
    let columns = queued?.first?["columns"] as? [String: Any]
    XCTAssertEqual(columns?["user_id"] as? String, kizunasyncTestOwner, "the queued insert carries the session user")

    do {
      try await client.pullOnce()
    } catch let error as KizunaSyncError {
      XCTAssertNotEqual(error.code, "BUCKET_UNSET", "an owner bucket needs no setBucket")
    }
    await client.dispose()
  }

  func testAMintedIdIsNotWrittenIntoTheColumnMap() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client()
    let table = try client.from("items")
    try await table.insert(["title": "alpha", "user_id": "u1"])
    let rows = try await table.select().execute() as? [[String: Any]]
    let pk = try XCTUnwrap(rows?.first?["id"] as? String)
    XCTAssertEqual(pk, pk.lowercased(), "a minted key is a lowercase uuid")
    XCTAssertEqual(rows?.count, 1)
  }
}

/// The fixed device identity every suite creates under. `create` refuses
/// anything that is not a uuid, because the server's registry column is one.
let kizunasyncTestClientId = "00000000-0000-4000-8000-0000000000c1"

/// The owner of a row that carries an attachment. `fromFile` refuses a
/// reference whose owner or key segment is not a uuid.
let kizunasyncTestOwner = "00000000-0000-4000-8000-0000000000a1"

/// The primary key of the row `kizunasyncTestOwner` owns.
let kizunasyncTestRowId = "00000000-0000-4000-8000-0000000000b1"

/**
 * The remote the suites create with: the packaged build requires one, and a
 * build without `http` refuses any. Nothing listens at the address. A call
 * without a token stops at `AUTH_SESSION_MISSING` before sending anything, and
 * the owner-bucket pull, which carries a token, fails to connect.
 */
let kizunasyncTestRemote = KizunaSyncRemoteConfig(url: "https://127.0.0.1:1", publishableKey: "pub-xxx")

/// An unsigned JWT naming `subject`: the engine reads the claim, and only the server verifies it.
private func kizunasyncTestToken(subject: String) -> String {
  func encoded(_ json: String) -> String {
    Data(json.utf8).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .trimmingCharacters(in: CharacterSet(charactersIn: "="))
  }
  return "\(encoded(#"{"alg":"none"}"#)).\(encoded("{\"sub\":\"\(subject)\"}")).unsigned"
}

/// One temporary store plus the client over it, so each test owns its own file.
struct Sandbox {
  let directory: URL

  init() throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("kizunasync-surface-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  func client(tables: [String] = ["items"]) async throws -> KizunaSyncClient {
    var declared: [String: KizunaSyncTableConfig] = [:]
    for table in tables {
      declared[table] = KizunaSyncTableConfig(bucket: .byColumn("user_id"))
    }
    let client = try await client(declaring: declared)
    try await client.setBucket(["user_id": "u1"])
    return client
  }

  /// The same store, with the table declarations spelled out, for a case that
  /// needs a soft-delete column or a conflict mode.
  func client(declaring tables: [String: KizunaSyncTableConfig]) async throws -> KizunaSyncClient {
    let client = KizunaSyncClient()
    try await client.create(
      KizunaSyncClientConfig(
        clientId: kizunasyncTestClientId,
        tables: tables,
        databasePath: directory.appendingPathComponent("kizunasync.sqlite").path,
        remote: kizunasyncTestRemote
      )
    )
    return client
  }

  func remove() {
    try? FileManager.default.removeItem(at: directory)
  }
}

#endif
