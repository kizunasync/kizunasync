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

  func testACompositeKeyRowIsWrittenAndReadBackByItsKeyColumns() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client(declaring: ["seats": KizunaSyncTableConfig(key: ["hall", "seat"])])
    let seats = try client.from("seats")
    try await seats.insert(["hall": 1, "seat": 12, "holder": "ada"])

    let rows = try await seats.select().eq("hall", 1).eq("seat", 12).execute() as? [[String: Any]]
    XCTAssertEqual(rows?.count, 1)
    XCTAssertEqual(rows?.first?["holder"] as? String, "ada")
    XCTAssertNil(rows?.first?["id"], "a composite key adds no id column")
    let snapshot = try await client.inspect()
    let queued = snapshot["queued"] as? [[String: Any]]
    XCTAssertEqual(queued?.first?["pk"] as? String, #"["1", "12"]"#)
  }

  func testAnIntegerIdReadsBackAsTheIntegerItWasWrittenAs() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client(declaring: ["notices": KizunaSyncTableConfig()])
    let notices = try client.from("notices")
    try await notices.insert(["id": 42, "body": "doors at ten"])

    let rows = try await notices.select().eq("id", 42).execute() as? [[String: Any]]
    XCTAssertEqual(rows?.count, 1)
    XCTAssertEqual(rows?.first?["id"] as? Int, 42)
  }

  func testAnUppercaseUuidIdIsStoredAndQueuedLowercase() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client()
    let id = UUID().uuidString
    try await client.from("items").insert(["id": id, "title": "alpha", "user_id": "u1"])

    let rows = try await client.from("items").select().eq("id", id).execute() as? [[String: Any]]
    XCTAssertEqual(rows?.first?["id"] as? String, id.lowercased(), "the filter on the key matches in any case")
    let queued = try await client.inspect()["queued"] as? [[String: Any]]
    XCTAssertEqual(queued?.first?["pk"] as? String, id.lowercased())
    XCTAssertEqual((queued?.first?["columns"] as? [String: Any])?["id"] as? String, id.lowercased())
  }

  func testAnInsertMissingAKeyColumnIsRefusedNamingIt() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client(declaring: ["seats": KizunaSyncTableConfig(key: ["hall", "seat"])])
    do {
      try await client.from("seats").insert(["hall": 1, "holder": "ada"])
      XCTFail("an insert without every key column must be refused")
    } catch {
      XCTAssertEqual((error as? KizunaSyncError)?.code, "LOCAL_CONSTRAINT")
      XCTAssertTrue(String(describing: error).contains("\"seat\""), "the refusal names the column, got \(error)")
    }
    let depth = try await client.outboxDepth()
    XCTAssertEqual(depth, 0)
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

  func testRangeSkipsThenCapsTheSortedRows() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client()
    let table = try client.from("items")
    for rank in [4, 2, 5, 1, 3] {
      try await table.insert(["id": "p\(rank)", "title": "t\(rank)", "user_id": "u1", "rank": rank])
    }
    func ids(_ rows: Any) -> [String] {
      (rows as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
    }

    let window = try await table.select().order("rank").range(from: 1, to: 2).execute()
    XCTAssertEqual(ids(window), ["p2", "p3"])
    let empty = try await table.select().order("rank").range(from: 3, to: 2).execute()
    XCTAssertEqual(ids(empty), [], "a to one below from keeps no row")
    let pastTheEnd = try await table.select().order("rank").range(from: 9, to: 12).execute()
    XCTAssertEqual(ids(pastTheEnd), [])
    let capped = try await table.select().order("rank").range(from: 1, to: 3).limit(1).execute()
    XCTAssertEqual(ids(capped), ["p2"], "a later limit replaces only the row count")
    let replaced = try await table.select().order("rank").limit(1).range(from: 3, to: 4).execute()
    XCTAssertEqual(ids(replaced), ["p4", "p5"], "a later range replaces the offset and the row count")

    let second = try await table.select().order("rank").range(from: 1, to: 1).single() as? [String: Any]
    XCTAssertEqual(second?["id"] as? String, "p2")
    let none = try await table.select().order("rank").range(from: 5, to: 9).maybeSingle()
    XCTAssertTrue(none is NSNull, "maybeSingle past the last row answers null, got \(none)")
    await client.dispose()
  }

  func testAnInvalidRangeIsLocalUnsupportedWhenTheReadRuns() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client()
    let table = try client.from("items")
    try await table.insert(["id": "p1", "title": "alpha", "user_id": "u1"])
    for (from, to) in [(-1, 2), (0, -1), (5, 3)] {
      do {
        _ = try await table.select().range(from: from, to: to).execute()
        XCTFail("range(\(from), \(to)) must be refused")
      } catch {
        XCTAssertEqual((error as? KizunaSyncError)?.code, "LOCAL_UNSUPPORTED")
        XCTAssertTrue(String(describing: error).contains("range(\(from), \(to))"), "\(error)")
      }
    }
    do {
      _ = try await table.select().range(from: -1, to: 2).range(from: 0, to: 0).single()
      XCTFail("an earlier invalid range still refuses the read")
    } catch {
      XCTAssertEqual((error as? KizunaSyncError)?.code, "LOCAL_UNSUPPORTED")
    }
    await client.dispose()
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

  func testAnIdThatIsNeitherAStringNorAnIntegerIsLocalConstraint() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client()
    do {
      try await client.from("items").insert(["id": 1.5, "title": "alpha", "user_id": "u1"])
      XCTFail("a fractional id must be refused, never replaced")
    } catch {
      XCTAssertEqual((error as? KizunaSyncError)?.code, "LOCAL_CONSTRAINT")
    }
    let depth = try await client.outboxDepth()
    XCTAssertEqual(depth, 0)
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
