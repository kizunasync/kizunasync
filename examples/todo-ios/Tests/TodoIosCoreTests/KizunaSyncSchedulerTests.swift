import Foundation
import XCTest

@testable import KizunaSync

/**
 * Long enough that a leftover timer misses every assertion window, short
 * enough to keep the suite under three seconds.
 */
private let pollSeconds: TimeInterval = 1.0

private struct SyncFailure: Error, Equatable {
  let reason: String
}

final class KizunaSyncSchedulerTests: XCTestCase {
  func testSyncFailureReachesOnError() {
    let failures = LockBox<[String]>([])
    let scheduler = KizunaSyncScheduler(
      client: KizunaSyncClient(),
      pollInterval: 0,
      monitorPath: false,
      refreshSession: { true },
      sync: { throw SyncFailure(reason: "offline") },
      onError: { error in
        failures.append((error as? SyncFailure)?.reason ?? "unknown")
      },
      jitterSource: { 1.0 }
    )
    scheduler.wake()
    spin(0.4)
    XCTAssertEqual(failures.snapshot(), ["offline"])
    scheduler.stop()
  }

  func testPollIntervalChangeRestartsTheTimer() {
    let runs = LockBox<Int>(0)
    let scheduler = KizunaSyncScheduler(
      client: KizunaSyncClient(),
      pollInterval: 60,
      monitorPath: false,
      refreshSession: { true },
      sync: { runs.increment() },
      jitterSource: { 1.0 }
    )
    scheduler.start()
    scheduler.pollInterval = 0.3
    spin(0.6)
    XCTAssertGreaterThanOrEqual(runs.snapshot(), 2, "the start attempt, then a tick at the new interval")
    scheduler.stop()
  }

  func testRefreshSessionChangeRestartsTheTimer() {
    let refreshes = LockBox<[String]>([])
    let scheduler = KizunaSyncScheduler(
      client: KizunaSyncClient(),
      pollInterval: pollSeconds,
      monitorPath: false,
      refreshSession: {
        refreshes.append("first")
        return true
      },
      sync: {},
      jitterSource: { 1.0 }
    )
    scheduler.start()
    spin(pollSeconds * 0.7)
    XCTAssertEqual(refreshes.snapshot(), ["first"], "the start attempt refreshes once")
    scheduler.refreshSession = {
      refreshes.append("second")
      return true
    }
    spin(pollSeconds * 0.5)
    XCTAssertEqual(refreshes.snapshot(), ["first"], "the swap must push the pending wake back a full interval")
    spin(pollSeconds * 0.7)
    XCTAssertEqual(refreshes.snapshot(), ["first", "second"])
    scheduler.stop()
  }

  func testConnectivitySignalWakesARunWhileTheMonitorIsOff() {
    let runs = LockBox<Int>(0)
    let scheduler = KizunaSyncScheduler(
      client: KizunaSyncClient(),
      pollInterval: 0,
      monitorPath: false,
      refreshSession: { true },
      sync: { runs.increment() },
      jitterSource: { 1.0 }
    )
    scheduler.start()
    spin(0.3)
    XCTAssertEqual(runs.snapshot(), 1, "only the start attempt runs while the monitor is off and no timer is armed")
    scheduler.notifyOnline()
    spin(0.3)
    XCTAssertEqual(runs.snapshot(), 2)
    scheduler.stop()
  }

  func testAnUnsatisfiedPathHoldsTheLoopAndASatisfiedOneResumesIt() {
    let runs = LockBox<Int>(0)
    let scheduler = KizunaSyncScheduler(
      client: KizunaSyncClient(),
      pollInterval: 0,
      monitorPath: true,
      refreshSession: { true },
      sync: { runs.increment() },
      jitterSource: { 1.0 }
    )
    /**
     * `start()` is left out on purpose: a live NWPathMonitor would report this
     * machine's real path and race every assertion below.
     */
    scheduler.reportPath(false)
    scheduler.wake()
    scheduler.notifyForeground()
    spin(0.3)
    XCTAssertEqual(runs.snapshot(), 0, "an unsatisfied path holds every run")
    scheduler.reportPath(true)
    spin(0.4)
    XCTAssertEqual(runs.snapshot(), 1, "the first satisfied report resumes the loop and wakes a run")
    scheduler.stop()
  }

  func testTurningMonitorPathOffWithoutAnArmedMonitorReopensTheGate() {
    let runs = LockBox<Int>(0)
    let scheduler = KizunaSyncScheduler(
      client: KizunaSyncClient(),
      pollInterval: 0,
      monitorPath: true,
      refreshSession: { true },
      sync: { runs.increment() },
      jitterSource: { 1.0 }
    )
    /**
     * Setup, not the assertion: cleared before start() so no live NWPathMonitor
     * is armed to report this machine's real path and race what follows.
     * `applyMonitorPath` only acts on a running scheduler, so this does nothing else.
     */
    scheduler.monitorPath = false
    scheduler.start()
    spin(0.3)
    XCTAssertEqual(runs.snapshot(), 1, "the start attempt runs before the path is shut")
    scheduler.reportPath(false)
    scheduler.wake()
    spin(0.3)
    XCTAssertEqual(runs.snapshot(), 1, "an unsatisfied path holds the wake")
    /**
     * The behaviour under test. It is a same-value write, and the `didSet` Swift
     * fires for it is the trigger. Only the reopen half of `applyMonitorPath`
     * runs here: its `stopPathMonitor()` half needs a live `NWPathMonitor`, which
     * is the same no-injection-point limit the gate case above records.
     */
    scheduler.monitorPath = false
    spin(0.4)
    XCTAssertEqual(runs.snapshot(), 2, "an app that asks for no gate must not stay held offline")
    scheduler.stop()
  }

  /// Runs the main run loop so the scheduler's `Timer` fires inside the test.
  private func spin(_ seconds: TimeInterval) {
    RunLoop.current.run(until: Date().addingTimeInterval(seconds))
  }
}

private final class LockBox<T>: @unchecked Sendable {
  private var value: T
  private let lock = NSLock()
  init(_ value: T) { self.value = value }

  func snapshot() -> T {
    lock.lock()
    defer { lock.unlock() }
    return value
  }

  func append(_ item: String) where T == [String] {
    lock.lock()
    value.append(item)
    lock.unlock()
  }

  @discardableResult
  func increment() -> Int where T == Int {
    lock.lock()
    defer { lock.unlock() }
    value += 1
    return value
  }
}
