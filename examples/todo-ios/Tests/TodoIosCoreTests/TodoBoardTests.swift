import Foundation
import KizunaSync
import TodoIosCore
import XCTest

final class TodoBoardTests: XCTestCase {
  func testSharedBoardOmitsRemoteWithoutCredentials() {
    let config = TodoBoard.clientConfig(
      clientId: todoTestClientId,
      databasePath: "/tmp/kizunasync-todos.sqlite",
      supabaseURL: nil,
      publishableKey: nil,
      accessToken: nil
    )
    let object = config.jsonObject()
    XCTAssertEqual(object["database_path"] as? String, "/tmp/kizunasync-todos.sqlite")
    XCTAssertNil(object["remote"])
    XCTAssertNotNil((object["tables"] as? [String: Any])?[TodoBoard.table])
  }

  func testCreateApplyQueryOnFileStore() async throws {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("todo-ios-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let path = dir.appendingPathComponent("kizunasync.sqlite").path

    let client = KizunaSyncClient()
    try await client.create(
      TodoBoard.clientConfig(
        clientId: todoTestClientId,
        databasePath: path,
        supabaseURL: todoTestRemoteURL,
        publishableKey: todoTestRemotePublishableKey,
        accessToken: nil
      )
    )
    let pk = UUID().uuidString
    try await client.apply(
      table: TodoBoard.table,
      pk: pk,
      op: .insert,
      columns: ["title": "works on a plane", "user_id": "user-1", "done": false],
      mutationId: UUID().uuidString
    )
    let depth = try await client.outboxDepth()
    XCTAssertEqual(depth, 1)

    let client2 = KizunaSyncClient()
    try await client2.create(
      TodoBoard.clientConfig(
        clientId: todoTestClientId,
        databasePath: path,
        supabaseURL: todoTestRemoteURL,
        publishableKey: todoTestRemotePublishableKey,
        accessToken: nil
      )
    )
    let rows = try await client2.query(
      table: TodoBoard.table,
      plan: ["cardinality": "many"]
    )
    let array = rows as? [[String: Any]]
    XCTAssertEqual(array?.count, 1)
  }

  func testClampedTitleKeepsATitleWithinTheLimit() {
    XCTAssertEqual(TodoBoard.clampedTitle("Buy milk"), "Buy milk")
  }

  func testClampedTitleCapsATitleOverTheLimit() {
    let over = String(repeating: "a", count: TodoBoard.titleMaxLength + 10)

    XCTAssertEqual(TodoBoard.clampedTitle(over), String(repeating: "a", count: TodoBoard.titleMaxLength))
  }

  func testAuthenticatedHttpRemoteConfig() {
    let config = TodoBoard.clientConfig(
      clientId: todoTestClientId,
      databasePath: "/tmp/kizunasync-todos.sqlite",
      supabaseURL: "https://abc.supabase.co",
      publishableKey: "pub-xxx",
      accessToken: "session-jwt"
    )
    let object = config.jsonObject()
    let remote = object["remote"] as? [String: Any]
    XCTAssertEqual(remote?["url"] as? String, "https://abc.supabase.co")
    XCTAssertEqual(remote?["publishable_key"] as? String, "pub-xxx")
    XCTAssertEqual(remote?["access_token"] as? String, "session-jwt")
    XCTAssertEqual(object["database_path"] as? String, "/tmp/kizunasync-todos.sqlite")
  }
}

/// The device identity the suite creates under. `create` refuses anything that
/// is not a uuid, because the server's registry column is one.
private let todoTestClientId = "00000000-0000-4000-8000-00000000da01"

/**
 * The remote the store is created with, because the packaged build requires one
 * and a build without `http` refuses any. The test never syncs, so nothing
 * contacts it.
 */
private let todoTestRemoteURL = "https://127.0.0.1:1"
private let todoTestRemotePublishableKey = "pub-xxx"
