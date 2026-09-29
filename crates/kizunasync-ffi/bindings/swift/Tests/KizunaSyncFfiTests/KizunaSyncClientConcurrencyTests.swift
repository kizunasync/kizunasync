import Foundation
import KizunaSync
import XCTest

#if canImport(KizunaSyncFfi)
import KizunaSyncFfi

/**
 * Holds `sync()` until the test releases it and answers `outboxDepth()` at once,
 * noting the dispatch queue it ran on, without a Rust engine behind it, so a
 * sync that waits on the network is reproducible on the host.
 */
private final class HeldSyncEngine: KizunaSyncFfi.KizunaSyncEngine, @unchecked Sendable {
  let release = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var entered = false
  private var depthQueueLabel: String?

  init() {
    super.init(noHandle: KizunaSyncFfi.KizunaSyncEngine.NoHandle())
  }

  required init(unsafeFromHandle handle: UInt64) {
    fatalError("HeldSyncEngine is never lifted from a handle")
  }

  var isHoldingSync: Bool {
    lock.lock()
    defer { lock.unlock() }
    return entered
  }

  var outboxDepthQueueLabel: String? {
    lock.lock()
    defer { lock.unlock() }
    return depthQueueLabel
  }

  override func sync() throws {
    lock.lock()
    entered = true
    lock.unlock()
    release.wait()
  }

  override func outboxDepth() throws -> UInt32 {
    let label = String(cString: __dispatch_queue_get_label(nil))
    lock.lock()
    depthQueueLabel = label
    lock.unlock()
    return 3
  }
}

/**
 * The engine answers a local call while a sync awaits the network, so the
 * client must not queue that call behind the sync on its own side.
 */
final class KizunaSyncClientConcurrencyTests: XCTestCase {
  func testALocalCallAnswersWhileASyncIsHeld() async throws {
    let engine = HeldSyncEngine()
    let client = KizunaSyncClient(engine: engine)
    let syncing = Task { try await client.sync() }
    var polls = 0
    while !engine.isHoldingSync && polls < 500 {
      try await Task.sleep(nanoseconds: 10_000_000)
      polls += 1
    }
    XCTAssertTrue(engine.isHoldingSync, "the sync never reached the engine")

    let answeredWhileHeld = await withTaskGroup(of: Bool.self) { group in
      group.addTask { (try? await client.outboxDepth()) == 3 }
      group.addTask {
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        return false
      }
      let first = await group.next() ?? false
      engine.release.signal()
      group.cancelAll()
      return first
    }
    try await syncing.value
    XCTAssertTrue(answeredWhileHeld, "outboxDepth waited for the held sync")
  }

  /**
   * A blocking FFI call parks its thread, so it must hold a thread of the
   * dedicated FFI queue and never one of the cooperative pool.
   */
  func testABlockingFfiCallRunsOnTheFfiQueue() async throws {
    let engine = HeldSyncEngine()
    let client = KizunaSyncClient(engine: engine)
    _ = try await client.outboxDepth()
    XCTAssertEqual(
      engine.outboxDepthQueueLabel,
      "com.kizunasync.kizunasync.ffi",
      "outboxDepth ran outside the FFI queue"
    )
  }
}

#endif
