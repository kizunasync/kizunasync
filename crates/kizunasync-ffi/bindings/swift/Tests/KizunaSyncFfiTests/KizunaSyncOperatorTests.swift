import Foundation
import KizunaSync
import XCTest

#if canImport(KizunaSyncFfi)

/// The supabase-swift operators past the core set, each run end to end
/// through the engine: the filters, the count and head options, `stripNulls`,
/// `csv`, the refusals, and the write chains' returning `select`.
final class KizunaSyncOperatorTests: XCTestCase {
  private func seeded(_ sandbox: Sandbox) async throws -> (KizunaSyncClient, KizunaSyncTable) {
    let client = try await sandbox.client()
    let table = try client.from("items")
    try await table.insert([
      "id": "p1", "title": "Alpha", "user_id": "u1", "rank": 2, "done": false, "note": "x", "tags": "[\"a\",\"b\"]",
    ])
    try await table.insert([
      "id": "p2", "title": "beta", "user_id": "u1", "rank": 1, "done": true, "note": NSNull(), "tags": "[\"c\"]",
    ])
    try await table.insert(["id": "p3", "title": "Gamma", "user_id": "u1", "rank": 3, "done": false])
    return (client, table)
  }

  private func ids(_ rows: Any) -> [String] {
    (rows as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
  }

  private func assertRefused(
    _ run: () async throws -> Any,
    code: String,
    naming fragment: String,
    file: StaticString = #filePath,
    line: UInt = #line
  ) async {
    do {
      _ = try await run()
      XCTFail("expected \(code) naming \(fragment)", file: file, line: line)
    } catch {
      XCTAssertEqual((error as? KizunaSyncError)?.code, code, "\(error)", file: file, line: line)
      XCTAssertTrue(String(describing: error).contains(fragment), "\(error)", file: file, line: line)
    }
  }

  func testTheOperatorsPastTheCoreSetSelectTheRowsTheKernelMatches() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let (client, table) = try await seeded(sandbox)

    let rows1 = try await table.select().order("rank").match("title", pattern: "^[AG]").execute()
    XCTAssertEqual(ids(rows1), ["p1", "p3"])
    let rows2 = try await table.select().imatch("title", pattern: "^BETA$").execute()
    XCTAssertEqual(ids(rows2), ["p2"])
    let rows3 = try await table.select().match(["done": false, "rank": 3]).execute()
    XCTAssertEqual(ids(rows3), ["p3"])
    let rows4 = try await table.select().likeAllOf("title", patterns: ["%a%", "%m%"]).execute()
    XCTAssertEqual(ids(rows4), ["p3"])
    let rows5 = try await table.select().order("rank").likeAnyOf("title", patterns: ["A%", "G%"]).execute()
    XCTAssertEqual(ids(rows5), ["p1", "p3"])
    let rows6 = try await table.select().iLikeAllOf("title", patterns: ["a%", "%A"]).execute()
    XCTAssertEqual(ids(rows6), ["p1"])
    let rows7 = try await table.select().iLikeAnyOf("title", patterns: ["b%"]).execute()
    XCTAssertEqual(ids(rows7), ["p2"])
    let rows8 = try await table.select().order("rank").isDistinct("note", value: "x").execute()
    XCTAssertEqual(ids(rows8), ["p2", "p3"])
    let rows9 = try await table.select().isDistinct("note", value: nil).execute()
    XCTAssertEqual(ids(rows9), ["p1"])
    let rows10 = try await table.select().notIn("id", values: ["p1", "p2"]).execute()
    XCTAssertEqual(ids(rows10), ["p3"])
    let rows11 = try await table.select().overlaps("tags", value: ["b", "z"]).execute()
    XCTAssertEqual(ids(rows11), ["p1"])
    let clauses = try await table.select()
      .filter("rank", operator: "gte", value: "2")
      .filter("title", operator: "not.like", value: "G*")
      .execute()
    XCTAssertEqual(ids(clauses), ["p1"])
    let rows12 = try await table.select().order("rank").filter("id", operator: "in", value: "(p1,p3)").execute()
    XCTAssertEqual(ids(rows12), ["p1", "p3"])
    await client.dispose()
  }

  func testCountHeadAndStripNullsShapeTheAnswer() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let (client, table) = try await seeded(sandbox)

    let page = try await table.select("id", count: .exact).order("rank").range(from: 0, to: 0).execute() as? [String: Any]
    XCTAssertEqual(page?["count"] as? Int, 3)
    XCTAssertEqual(ids(page?["rows"] as Any), ["p2"])
    let head = try await table.select(head: true, count: .planned).eq("done", false).execute() as? [String: Any]
    XCTAssertEqual(head?["count"] as? Int, 2)
    XCTAssertTrue(head?["rows"] is NSNull, "a head read has no rows, got \(String(describing: head))")
    let stripped = try await table.select("id, note").eq("id", "p2").stripNulls().retry(enabled: false).single() as? [String: Any]
    XCTAssertEqual(stripped?.keys.sorted(), ["id"])
    await client.dispose()
  }

  func testCsvQuotesFieldsAndOrdersTheHeader() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let (client, table) = try await seeded(sandbox)
    try await table.insert(["id": "p4", "title": "a, \"quoted\" title", "user_id": "u1", "rank": 4])

    let projected = try await table.select("id, title").order("rank").csv()
    XCTAssertEqual(projected, "id,title\np2,beta\np1,Alpha\np3,Gamma\np4,\"a, \"\"quoted\"\" title\"")
    let everyColumn = try await table.select().eq("id", "p3").csv()
    XCTAssertEqual(everyColumn, "done,id,rank,title,user_id\nfalse,p3,3,Gamma,u1")
    let empty = try await table.select("id").eq("id", "none").csv()
    XCTAssertEqual(empty, "id")
    await client.dispose()
  }

  func testAMethodWithNoLocalMeaningIsRefusedWhenTheReadRuns() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let (client, table) = try await seeded(sandbox)

    await assertRefused({ try await table.select().filter("tags", operator: "cs", value: "{a}").execute() }, code: "LOCAL_UNSUPPORTED", naming: "unsupported filter operator \"cs\"")
    await assertRefused({ try await table.select().filter("title", operator: "eq", value: "\"open").execute() }, code: "LOCAL_UNSUPPORTED", naming: "unclosed double quote")
    await assertRefused({ try await table.select().match("title", pattern: "(a)\\1").execute() }, code: "LOCAL_UNSUPPORTED", naming: "(a)\\1")
    await assertRefused({ try await table.select().dryRun().execute() }, code: "LOCAL_UNSUPPORTED", naming: "local writes enter the outbox")
    await assertRefused({ try await table.select().geojson().single() }, code: "LOCAL_UNSUPPORTED", naming: "PostGIS")
    await assertRefused({ try await table.select().explain(analyze: true).execute() }, code: "LOCAL_UNSUPPORTED", naming: "server query planner")
    await assertRefused({ try await table.select().setHeader(name: "x", value: "y").csv() }, code: "LOCAL_UNSUPPORTED", naming: "no HTTP request")
    await client.dispose()
  }

  func testAWriteSelectReturnsTheRowsItReached() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let (client, table) = try await seeded(sandbox)

    let updated = try await table.update(["done": true]).eq("done", false).select("id, done").execute() as? [[String: Any]]
    XCTAssertEqual(updated?.map { $0["id"] as? String }, ["p1", "p3"])
    XCTAssertEqual(updated?.map { $0["done"] as? Bool }, [true, true])
    let deleted = try await table.delete().eq("id", "p2").select("id, title, note").stripNulls().single() as? [String: Any]
    XCTAssertEqual(deleted?["title"] as? String, "beta")
    XCTAssertNil(deleted?["note"])
    let none = try await table.delete().eq("id", "absent").select().maybeSingle()
    XCTAssertTrue(none is NSNull, "\(none)")
    let keys13 = try await table.update(["title": "x"]).notIn("id", values: ["p1"]).likeAnyOf("title", patterns: ["G%"]).execute()
    XCTAssertEqual(keys13, ["p3"])
    await client.dispose()
  }

  func testAOneRowOrCappedWriteThatBreaksItsBoundWritesNothing() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let (client, table) = try await seeded(sandbox)
    let depth = try await client.outboxDepth()

    await assertRefused({ try await table.update(["title": "z"]).eq("done", false).select().single() }, code: "LOCAL_CONSTRAINT", naming: "single() requires exactly one row; got 2")
    await assertRefused({ try await table.update(["title": "z"]).eq("id", "absent").select().single() }, code: "LOCAL_CONSTRAINT", naming: "single() requires exactly one row; got 0")
    await assertRefused({ try await table.delete().eq("done", false).select().maybeSingle() }, code: "LOCAL_CONSTRAINT", naming: "maybeSingle() requires at most one row; got 2")
    await assertRefused({ try await table.update(["title": "z"]).eq("done", false).maxAffected(1).execute() }, code: "LOCAL_CONSTRAINT", naming: "maxAffected(1)")
    await assertRefused({ try await table.delete().eq("done", false).maxAffected(-1).execute() }, code: "LOCAL_UNSUPPORTED", naming: "maxAffected(-1)")
    await assertRefused({ try await table.update(["title": "z"]).eq("id", "p1").select("id, author(name)").execute() }, code: "LOCAL_UNSUPPORTED", naming: "without foreign-key joins")
    await assertRefused({ try await table.update(["title": "z"]).eq("id", "p1").dryRun().execute() }, code: "LOCAL_UNSUPPORTED", naming: "outbox")
    let unchanged = try await client.outboxDepth()
    XCTAssertEqual(unchanged, depth)
    let keys14 = try await table.update(["title": "z"]).eq("done", false).maxAffected(2).retry(enabled: true).execute()
    XCTAssertEqual(keys14, ["p1", "p3"])
    await client.dispose()
  }
}

#endif
