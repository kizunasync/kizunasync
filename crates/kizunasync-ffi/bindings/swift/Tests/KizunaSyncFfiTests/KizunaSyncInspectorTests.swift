import Foundation
import XCTest

@testable import KizunaSync

#if canImport(KizunaSyncFfi)
import KizunaSyncFfi

final class KizunaSyncInspectorTests: XCTestCase {
  func testSnapshotReadsTheTypedQueue() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client()
    try await client.from("items").insert(["id": "p1", "title": "alpha", "user_id": "u1"])
    let inspector = try await client.inspector()
    let queued = try await inspector.snapshot()
    XCTAssertEqual(queued.depth, 1)
    XCTAssertEqual(queued.cursor, "0")
    XCTAssertEqual(queued.queued.count, 1)
    // The field is the exactly-once push watermark, so it stays nil until a push lands.
    XCTAssertNil(queued.lastMutationId)
    do {
      try await client.sync()
    } catch let error as KizunaSyncError where error.code == "AUTH_SESSION_MISSING" || error.code.hasPrefix("REMOTE") {
      throw XCTSkip("queue snapshot across a push needs the offline scripted remote; the packaging build has none")
    }
    let pushed = try await inspector.snapshot()
    XCTAssertEqual(pushed.depth, 0)
    XCTAssertNotNil(pushed.lastMutationId)
    await client.dispose()
  }

  func testOneInspectorPerClient() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client()
    let first = try await client.inspector()
    let second = try await client.inspector()
    XCTAssertTrue(first === second)
    await client.dispose()
  }

  func testTheRingRecordsBothRefusalsAndCapsAtFifty() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client()
    let inspector = try await client.inspector()
    XCTAssertTrue(inspector.verdicts().isEmpty)

    inspector.record(.mutationRejected(mutationId: "m1", reason: "rls"))
    inspector.record(.batchAborted(offenderMutationId: "m2", reason: "conflict"))
    inspector.record(.localChanged)

    let recorded = inspector.verdicts()
    XCTAssertEqual(recorded.count, 2, "only a refusal joins the ring")
    XCTAssertEqual(recorded[0].mutationId, "m1")
    XCTAssertEqual(recorded[0].kind, .rejected)
    XCTAssertEqual(recorded[0].reason, "rls")
    XCTAssertEqual(recorded[1].mutationId, "m2")
    XCTAssertEqual(recorded[1].kind, .aborted)

    for index in 0..<60 {
      inspector.record(.mutationRejected(mutationId: "n\(index)", reason: "rls"))
    }
    let capped = inspector.verdicts()
    XCTAssertEqual(capped.count, 50)
    XCTAssertEqual(capped.first?.mutationId, "n10", "the ring drops the oldest first")
    XCTAssertEqual(capped.last?.mutationId, "n59")
    await client.dispose()
  }

  func testTheRingRecordsAnOverwrittenColumn() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client()
    let inspector = try await client.inspector()

    inspector.record(
      .columnOverwritten(
        table: "items",
        pk: "p1",
        column: "title",
        loserValueJson: "\"mine\"",
        winnerMutationId: "peer-1",
        conflictMode: "hlc"
      )
    )

    let recorded = inspector.verdicts()
    XCTAssertEqual(recorded.count, 1)
    XCTAssertEqual(recorded[0].kind, .overwritten)
    XCTAssertEqual(recorded[0].mutationId, "peer-1", "the winner is a peer's write")
    XCTAssertEqual(recorded[0].reason, "items.title", "the column the peer took")
    await client.dispose()
  }

  func testSubscribeAndClear() async throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let client = try await sandbox.client()
    let inspector = try await client.inspector()
    let changes = Counter()
    let unsubscribe = inspector.subscribe { changes.increment() }

    inspector.record(.mutationRejected(mutationId: "m1", reason: "rls"))
    XCTAssertEqual(changes.value, 1)
    inspector.clear()
    XCTAssertEqual(changes.value, 2)
    XCTAssertTrue(inspector.verdicts().isEmpty)

    unsubscribe()
    inspector.record(.mutationRejected(mutationId: "m2", reason: "rls"))
    XCTAssertEqual(changes.value, 2, "an unsubscribed observer hears nothing")
    XCTAssertEqual(inspector.verdicts().count, 1, "the ring keeps recording")
    await client.dispose()
  }
}

private final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0

  var value: Int {
    lock.lock()
    defer { lock.unlock() }
    return count
  }

  func increment() {
    lock.lock()
    count += 1
    lock.unlock()
  }
}

#endif
