import Foundation
import KizunaSync
import XCTest

#if canImport(KizunaSyncFfi)
import KizunaSyncFfi

/**
 * The kernel capabilities the client reaches through the JSON-RPC surface
 * rather than through a typed UniFFI method: the attachment controls, the
 * overwrite journal, and the soft-delete modifier on a read. Each case pins the
 * same answers the shared scenario oracle pins for the same kernel method.
 */
final class KizunaSyncClientControlsTests: XCTestCase {
  func testAnUnknownReferenceAnswersFalseOrNil() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client()

    let retried = try await client.attachmentRetry("u1/p1/absent.png")
    XCTAssertFalse(retried, "no row carries the reference")
    let cancelled = try await client.attachmentCancel("u1/p1/absent.png")
    XCTAssertFalse(cancelled)
    let removed = try await client.attachmentRemove("u1/p1/absent.png")
    XCTAssertNil(removed)
    await client.dispose()
  }

  func testCancelKeepsTheRowAndRemoveHandsBackTheSandboxPath() async throws {
    let staged = try await stageAttachment()
    defer { staged.remove() }

    let cancelled = try await staged.client.attachmentCancel(staged.reference)
    XCTAssertTrue(cancelled)
    let afterCancel = try await staged.client.getStatus(staged.reference)
    XCTAssertEqual(afterCancel?.state, "failed")
    XCTAssertEqual(afterCancel?.permanent, false, "cancel leaves the row retryable")

    let retried = try await staged.client.attachmentRetry(staged.reference)
    XCTAssertTrue(retried)
    let afterRetry = try await staged.client.getStatus(staged.reference)
    XCTAssertEqual(afterRetry?.state, "queued")

    let path = try await staged.client.attachmentRemove(staged.reference)
    XCTAssertEqual(path, staged.localPath, "remove answers the bytes the host still holds")
    let afterRemove = try await staged.client.getStatus(staged.reference)
    XCTAssertNil(afterRemove?.localPath, "the row is gone, so the status is the missing placeholder")
    let second = try await staged.client.attachmentRemove(staged.reference)
    XCTAssertNil(second, "a second remove answers nothing")
    await staged.client.dispose()
  }

  func testTheStatusCarriesTheFailureCodeAndTheEvictedState() async throws {
    let staged = try await stageAttachment()
    defer { staged.remove() }
    let queued = try await staged.client.getStatus(staged.reference)
    XCTAssertEqual(queued?.state, "queued")
    XCTAssertNil(queued?.errorCode, "a row with no recorded failure carries no code")

    let patch: [String: Any] = [
      "reference": staged.reference,
      "patch": ["state": "evicted", "error": "refused", "error_code": "TRANSFER"],
    ]
    let params = String(decoding: try JSONSerialization.data(withJSONObject: patch), as: UTF8.self)
    let envelope = try staged.engine.call(method: "attachment_patch", paramsJson: params)
    XCTAssertTrue(envelope.contains("\"ok\":true"), "the patch was refused: \(envelope)")

    let evicted = try await staged.client.getStatus(staged.reference)
    XCTAssertEqual(evicted?.state, "evicted")
    XCTAssertEqual(evicted?.errorCode, "TRANSFER")
    XCTAssertEqual(evicted?.error, "refused")
    await staged.client.dispose()
  }

  func testTheOverwriteJournalIsEmptyUntilAPeerWins() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client()

    let entries = try await client.overwrites()
    XCTAssertTrue(entries.isEmpty)
    let dismissed = try await client.dismissOverwrite(1)
    XCTAssertFalse(dismissed, "no entry carries that id")
    let withDismissed = try await client.overwrites(includeDismissed: true)
    XCTAssertTrue(withDismissed.isEmpty)
    await client.dispose()
  }

  func testIncludeDeletedBringsBackAMarkedRow() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client(
      declaring: [
        "items": KizunaSyncTableConfig(bucket: .byColumn("user_id"), softDeleteColumn: "deleted_at"),
      ]
    )
    try await client.from("items").insert(["id": "p1", "title": "Alpha", "user_id": "u1"])
    try await client.from("items").insert(["id": "p2", "title": "Bravo", "user_id": "u1"])
    _ = try await client.from("items").delete().eq("id", "p1").execute()

    let visible = try await client.from("items").select().execute() as? [[String: Any]]
    XCTAssertEqual(visible?.count, 1, "a marked row leaves the default read")
    let all = try await client.from("items").select().includeDeleted().execute() as? [[String: Any]]
    XCTAssertEqual(all?.count, 2)
    let marked = all?.first { $0["id"] as? String == "p1" }
    XCTAssertNotNil(marked?["deleted_at"], "the delete stamped the column instead of removing the row")
    await client.dispose()
  }

  func testANonUuidClientIdIsRefused() async {
    let client = KizunaSyncClient()
    do {
      try await client.create(
        KizunaSyncClientConfig(clientId: "local-dev", tables: ["items": KizunaSyncTableConfig()])
      )
      XCTFail("expected CONFIG_INVALID")
    } catch {
      guard case KizunaSyncError.engine(let code, _) = error else {
        XCTFail("expected KizunaSyncError.engine, got \(error)")
        return
      }
      XCTAssertEqual(code, "CONFIG_INVALID")
    }
  }
}

/// One queued upload behind a real client, so the controls run against a row the
/// engine wrote rather than against a fixture.
private struct StagedAttachment {
  let directory: URL
  let engine: KizunaSyncFfi.KizunaSyncEngine
  let client: KizunaSyncClient
  let reference: String
  let localPath: String

  func remove() {
    try? FileManager.default.removeItem(at: directory)
  }
}

private func stageAttachment() async throws -> StagedAttachment {
  let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("kizunasync-controls-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let source = directory.appendingPathComponent("photo.bin")
  try Data("hello-bytes".utf8).write(to: source)

  let engine = KizunaSyncFfi.KizunaSyncEngine()
  let client = KizunaSyncClient(engine: engine)
  try await client.create(
    KizunaSyncClientConfig(
      clientId: kizunasyncTestClientId,
      tables: [
        "items": KizunaSyncTableConfig(
          bucket: .byColumn("user_id"),
          attachments: ["image": KizunaSyncAttachmentSpec(storageBucket: "media", ownerColumn: "user_id")]
        ),
      ],
      databasePath: directory.appendingPathComponent("kizunasync.sqlite").path,
      remote: kizunasyncTestRemote,
      attachmentRoot: directory.appendingPathComponent("sandbox").path
    )
  )
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
    pk: kizunasyncTestRowId,
    sourcePath: source.path,
    mediaType: "image/png"
  )
  return StagedAttachment(
    directory: directory,
    engine: engine,
    client: client,
    reference: imported.reference,
    localPath: imported.localPath
  )
}

#endif
