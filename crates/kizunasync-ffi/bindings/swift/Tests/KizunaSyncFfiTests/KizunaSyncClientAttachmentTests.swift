import Foundation
import KizunaSync
import XCTest

#if canImport(KizunaSyncFfi)

final class KizunaSyncClientAttachmentTests: XCTestCase {
  func testCreateWithoutAttachmentRootFailsOnHost() async {
    let client = KizunaSyncClient()
    let config = KizunaSyncClientConfig(
      clientId: kizunasyncTestClientId,
      tables: [
        "items": KizunaSyncTableConfig(
          bucket: .byColumn("user_id"),
          attachments: ["image": KizunaSyncAttachmentSpec(storageBucket: "media", ownerColumn: "user_id")]
        ),
      ],
      remote: kizunasyncTestRemote
    )
    do {
      try await client.create(config)
      XCTFail("expected ATTACHMENT_PORTS_MISSING")
    } catch {
      XCTAssertTrue(String(describing: error).contains("ATTACHMENT_PORTS_MISSING"))
    }
  }

  func testFromFileEnqueuesWithoutRemote() async throws {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("kizunasync-att-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let source = dir.appendingPathComponent("photo.bin")
    try Data("hello-bytes".utf8).write(to: source)
    let db = dir.appendingPathComponent("kizunasync.sqlite").path
    let sandbox = dir.appendingPathComponent("sandbox").path

    let client = KizunaSyncClient()
    do {
      try await client.create(
        KizunaSyncClientConfig(
          clientId: kizunasyncTestClientId,
          tables: [
            "items": KizunaSyncTableConfig(
              bucket: .byColumn("user_id"),
              attachments: ["image": KizunaSyncAttachmentSpec(storageBucket: "media", ownerColumn: "user_id")]
            ),
          ],
          databasePath: db,
          attachmentRoot: sandbox
        )
      )
    } catch KizunaSyncError.engine(let code, let message)
      where code == "CONFIG_INVALID" && message.contains("remote is required") {
      throw XCTSkip("packaging build requires a remote")
    }
    try await client.setBucket(["user_id": kizunasyncTestOwner])
    try await client.apply(
      table: "items",
      pk: kizunasyncTestRowId,
      op: .insert,
      columns: ["title": "pic", "user_id": kizunasyncTestOwner],
      mutationId: UUID().uuidString
    )
    let imported = try await client.fromFile(
      table: "items",
      column: "image",
      pk: kizunasyncTestRowId.uppercased(),
      sourcePath: source.path,
      mediaType: "image/png"
    )
    XCTAssertTrue(
      imported.reference.contains("/\(kizunasyncTestRowId)/"),
      "an uppercase pk names the row the insert stored in lowercase, got \(imported.reference)"
    )
    let status = try await client.getStatus(imported.reference)
    XCTAssertEqual(status?.state, "queued")
    try await client.sync()
    let resolved = try await client.resolveDownload(imported.reference)
    XCTAssertEqual(resolved, imported.localPath)
  }
}

#endif
