import Foundation
import KizunaSync
import XCTest

final class KizunaSyncClientConfigTests: XCTestCase {
  func testEncodeOmitsRemoteWhenAbsent() throws {
    let config = KizunaSyncClientConfig(
      clientId: kizunasyncTestClientId,
      tables: ["todos": KizunaSyncTableConfig()]
    )
    let object = config.jsonObject()
    XCTAssertEqual(object["client_id"] as? String, kizunasyncTestClientId)
    XCTAssertNil(object["remote"])
    XCTAssertNil(object["database_path"])
    XCTAssertNil(object["default_limit"], "an unset page size leaves limit to the server")
    XCTAssertNil(object["attachment_attempts"], "an unset budget leaves the engine's own")
  }

  func testEncodeWritesTheOptionalEngineKeys() throws {
    let config = KizunaSyncClientConfig(
      clientId: kizunasyncTestClientId,
      tables: ["todos": KizunaSyncTableConfig(conflictMode: .hlc)],
      defaultLimit: 250,
      attachmentAttempts: 3
    )
    let object = config.jsonObject()
    XCTAssertEqual(object["default_limit"] as? Int, 250)
    XCTAssertEqual(object["attachment_attempts"] as? Int, 3)
    let tables = object["tables"] as? [String: [String: Any]]
    XCTAssertEqual(tables?["todos"]?["conflict_mode"] as? String, "hlc")
  }

  func testAnArrivalTableCarriesNoConflictMode() throws {
    let config = KizunaSyncClientConfig(
      clientId: kizunasyncTestClientId,
      tables: ["todos": KizunaSyncTableConfig()]
    )
    let tables = config.jsonObject()["tables"] as? [String: [String: Any]]
    XCTAssertNil(
      tables?["todos"]?["conflict_mode"],
      "arrival is the engine default, so the key stays off the wire"
    )
  }

  func testAPullOnlyTableCarriesItsSyncMode() throws {
    let config = KizunaSyncClientConfig(
      clientId: kizunasyncTestClientId,
      tables: ["todos": KizunaSyncTableConfig(syncMode: .pullOnly)]
    )
    let tables = config.jsonObject()["tables"] as? [String: [String: Any]]
    XCTAssertEqual(tables?["todos"]?["sync_mode"] as? String, "pull-only")
  }

  func testAReadWriteTableCarriesNoSyncMode() throws {
    let config = KizunaSyncClientConfig(
      clientId: kizunasyncTestClientId,
      tables: ["todos": KizunaSyncTableConfig(syncMode: .readWrite)]
    )
    let tables = config.jsonObject()["tables"] as? [String: [String: Any]]
    XCTAssertNil(
      tables?["todos"]?["sync_mode"],
      "read-write is the engine default, so the key stays off the wire"
    )
  }

  func testAnUnbucketedTableCarriesNoBucketKeys() {
    let config = KizunaSyncClientConfig(
      clientId: kizunasyncTestClientId,
      tables: ["todos": KizunaSyncTableConfig()]
    )
    let todos = (config.jsonObject()["tables"] as? [String: Any])?["todos"] as? [String: Any]
    XCTAssertNotNil(todos)
    XCTAssertNil(todos?["bucket_column"], "a table with no bucket pulls every row RLS allows")
    XCTAssertNil(todos?["bucket_owner"])
    XCTAssertNil(todos?["bucket_params"], "bucket values reach the engine through setBucket only")
  }

  func testAnOwnerBucketNamesItsColumnAndAsksForTheOwner() {
    let config = KizunaSyncClientConfig(
      clientId: kizunasyncTestClientId,
      tables: ["todos": KizunaSyncTableConfig(bucket: .byOwner("user_id"))]
    )
    let todos = (config.jsonObject()["tables"] as? [String: Any])?["todos"] as? [String: Any]
    XCTAssertEqual(todos?["bucket_column"] as? String, "user_id")
    XCTAssertEqual(todos?["bucket_owner"] as? Bool, true, "the engine fills the value from the session")
    XCTAssertNil(todos?["bucket_params"])
  }

  func testAColumnBucketNamesItsColumnAlone() {
    let config = KizunaSyncClientConfig(
      clientId: kizunasyncTestClientId,
      tables: ["boards": KizunaSyncTableConfig(bucket: .byColumn("team_id"))]
    )
    let boards = (config.jsonObject()["tables"] as? [String: Any])?["boards"] as? [String: Any]
    XCTAssertEqual(boards?["bucket_column"] as? String, "team_id")
    XCTAssertNil(boards?["bucket_owner"], "the app names the value through setBucket")
    XCTAssertNil(boards?["bucket_params"])
  }

  func testAnAbsentClientIdMintsAUuid() throws {
    let config = KizunaSyncClientConfig(tables: ["todos": KizunaSyncTableConfig()])
    XCTAssertNotNil(UUID(uuidString: config.clientId))
  }

  func testEncodeWritesRemoteAndPath() throws {
    let config = KizunaSyncClientConfig(
      clientId: kizunasyncTestClientId,
      tables: ["todos": KizunaSyncTableConfig(bucket: .byColumn("user_id"))],
      databasePath: "/tmp/kizunasync.sqlite",
      remote: KizunaSyncRemoteConfig(url: "https://example.supabase.co", publishableKey: "pub")
    )
    let object = config.jsonObject()
    XCTAssertEqual(object["database_path"] as? String, "/tmp/kizunasync.sqlite")
    let remote = object["remote"] as? [String: Any]
    XCTAssertEqual(remote?["url"] as? String, "https://example.supabase.co")
    XCTAssertEqual(remote?["publishable_key"] as? String, "pub")
  }

  func testEncodeWritesAttachments() {
    let config = KizunaSyncClientConfig(
      clientId: kizunasyncTestClientId,
      tables: [
        "todos": KizunaSyncTableConfig(
          attachments: ["image": KizunaSyncAttachmentSpec(storageBucket: "media", ownerColumn: "user_id")]
        ),
      ],
      attachmentRoot: "/tmp/kizunasync-bytes"
    )
    let object = config.jsonObject()
    XCTAssertEqual(object["attachment_root"] as? String, "/tmp/kizunasync-bytes")
    let todos = (object["tables"] as? [String: Any])?["todos"] as? [String: Any]
    let image = (todos?["attachments"] as? [String: Any])?["image"] as? [String: Any]
    XCTAssertEqual(image?["storage_bucket"] as? String, "media")
  }

  func testQueryHelpersCoverTheLocalAst() {
    XCTAssertEqual(KizunaSyncQuery.neq("done", true)["kind"] as? String, "neq")
    XCTAssertEqual(KizunaSyncQuery.ilike("title", "%plane%")["pattern"] as? String, "%plane%")
    XCTAssertEqual(KizunaSyncQuery.`in`("id", ["a", "b"])["kind"] as? String, "in")
    XCTAssertEqual(KizunaSyncQuery.or([KizunaSyncQuery.eq("done", false)])["kind"] as? String, "or")
    XCTAssertEqual(KizunaSyncQuery.maybeSingle()["cardinality"] as? String, "maybeSingle")
  }

  func testTheSortKeyUsesTheWireName() {
    let ordered = KizunaSyncQuery.order("title", ascending: false, nullsFirst: true)
    XCTAssertEqual(ordered["nullsFirst"] as? Bool, true)
    XCTAssertNil(ordered["nulls_first"])
  }

  func testTheIdentityTestTakesABooleanOrNull() {
    XCTAssertEqual(KizunaSyncQuery.`is`("done", true)["value"] as? Bool, true)
    XCTAssertTrue(KizunaSyncQuery.`is`("done", nil)["value"] is NSNull)
  }

  func testTextSearchCarriesTheClosedParseMode() {
    XCTAssertEqual(
      KizunaSyncQuery.textSearch("title", "plane", type: .websearch)["type"] as? String,
      "websearch"
    )
    XCTAssertEqual(KizunaSyncQuery.textSearch("title", "plane")["type"] as? String, "plain")
  }

  func testEncodeWritesSoftDeleteColumn() {
    let config = KizunaSyncClientConfig(
      clientId: kizunasyncTestClientId,
      tables: ["todos": KizunaSyncTableConfig(softDeleteColumn: "deleted_at")]
    )
    let todos = (config.jsonObject()["tables"] as? [String: Any])?["todos"] as? [String: Any]
    XCTAssertEqual(todos?["soft_delete_column"] as? String, "deleted_at")
  }
}
