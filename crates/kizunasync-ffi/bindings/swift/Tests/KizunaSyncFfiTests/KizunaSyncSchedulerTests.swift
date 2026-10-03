import Foundation
import XCTest

@testable import KizunaSync

#if canImport(KizunaSyncFfi)
import KizunaSyncFfi

final class KizunaSyncSchedulerTests: XCTestCase {
  func testForegroundRefreshesThenSyncs() async {
    let order = LockBox<[String]>([])
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 0,
      monitorPath: false,
      refreshSession: {
        order.append("refresh")
        return true
      },
      sync: {
        order.append("sync")
      }
    )
    scheduler.notifyForeground()
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertEqual(order.snapshot(), ["refresh", "sync"])
    scheduler.stop()
  }

  func testMissingSessionSkipsSync() async {
    let order = LockBox<[String]>([])
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 0,
      monitorPath: false,
      refreshSession: {
        order.append("refresh")
        return false
      },
      sync: {
        order.append("sync")
      }
    )
    scheduler.wake(reason: .doorbell)
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertEqual(order.snapshot(), ["refresh"])
    scheduler.stop()
  }

  func testConcurrentWakesRunAtMostTwiceWithoutOverlap() async {
    let runCount = LockBox<Int>(0)
    let concurrentRuns = LockBox<Int>(0)
    let maxConcurrentRuns = LockBox<Int>(0)
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 0,
      monitorPath: false,
      refreshSession: { true },
      sync: {
        let concurrent = concurrentRuns.increment()
        maxConcurrentRuns.updateMax(concurrent)
        runCount.increment()
        try? await Task.sleep(nanoseconds: 50_000_000)
        concurrentRuns.decrement()
      }
    )
    // Real Tasks on the parallel executor reproduce the check-then-act race.
    await withTaskGroup(of: Void.self) { group in
      for _ in 0..<20 {
        group.addTask { scheduler.wake() }
      }
    }
    try? await Task.sleep(nanoseconds: 300_000_000)
    XCTAssertEqual(maxConcurrentRuns.snapshot(), 1)
    XCTAssertLessThanOrEqual(runCount.snapshot(), 2)
    scheduler.stop()
  }

  func testHealthTracksSuccessAndFailure() async {
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 0,
      monitorPath: false,
      refreshSession: { true },
      sync: { throw KizunaSyncError.engine(code: "REMOTE_UNAVAILABLE", message: "offline") }
    )
    XCTAssertEqual(scheduler.health().phase, .idle)
    scheduler.wake()
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertEqual(scheduler.health().consecutiveFailures, 1)
    XCTAssertEqual(scheduler.health().phase, .backoff)
    scheduler.stop()
  }

  func testTheLastErrorCarriesTheCodeAndTheMessage() async {
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 0,
      monitorPath: false,
      refreshSession: { true },
      sync: { throw KizunaSyncError.engine(code: "REMOTE_UNAVAILABLE", message: "offline") }
    )
    scheduler.wake()
    try? await Task.sleep(nanoseconds: 200_000_000)
    let failure = scheduler.health().lastError
    XCTAssertEqual(failure?.code, "REMOTE_UNAVAILABLE")
    XCTAssertEqual(failure?.message, "offline")
    XCTAssertNotNil(failure?.at)
    scheduler.stop()
  }

  func testAnUncodedFailureKeepsItsText() async {
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 0,
      monitorPath: false,
      refreshSession: { true },
      sync: { throw NSError(domain: "kizunasync-test", code: 1) }
    )
    scheduler.wake()
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertNil(scheduler.health().lastError?.code)
    XCTAssertFalse(scheduler.health().lastError?.message.isEmpty ?? true)
    scheduler.stop()
  }

  // MARK: - Arming, jitter, backoff

  func testEveryArmIsJitteredWithinHalfTheDelay() {
    /// Read on every arm, so one scheduler can be walked from the low end of
    /// the window to the high end.
    let fraction = LockBox<Double>(0)
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 8,
      monitorPath: false,
      refreshSession: { true },
      sync: {},
      jitterSource: { fraction.snapshot() }
    )
    scheduler.start()
    XCTAssertEqual(
      scheduler.health().nextAttemptAt?.timeIntervalSinceNow ?? 0,
      4,
      accuracy: 0.5,
      "the low end of the window is half the delay"
    )

    fraction.set(0.999_999)
    scheduler.pollInterval = 8
    XCTAssertEqual(
      scheduler.health().nextAttemptAt?.timeIntervalSinceNow ?? 0,
      8,
      accuracy: 0.5,
      "the high end of the window is the whole delay"
    )
    scheduler.stop()
  }

  func testBackoffGrowsAfterAFailureAndResetsAfterASuccess() {
    let failing = LockBox<Bool>(false)
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 4,
      monitorPath: false,
      refreshSession: { true },
      sync: {
        if failing.snapshot() {
          throw KizunaSyncError.engine(code: "REMOTE_UNAVAILABLE", message: "offline")
        }
      },
      jitterSource: { 0 }
    )
    scheduler.start()
    XCTAssertEqual(
      scheduler.health().nextAttemptAt?.timeIntervalSinceNow ?? 0,
      2,
      accuracy: 0.5
    )
    // The start attempt succeeds and settles before the failing one.
    spin(0.4)
    XCTAssertEqual(scheduler.health().consecutiveFailures, 0)

    failing.set(true)
    scheduler.wake()
    spin(0.4)
    XCTAssertEqual(scheduler.health().consecutiveFailures, 1)
    XCTAssertEqual(
      scheduler.health().nextAttemptAt?.timeIntervalSinceNow ?? 0,
      4,
      accuracy: 0.5,
      "one failure doubles the delay before the jitter halves it"
    )

    failing.set(false)
    scheduler.wake()
    spin(0.4)
    XCTAssertEqual(scheduler.health().consecutiveFailures, 0)
    XCTAssertEqual(
      scheduler.health().nextAttemptAt?.timeIntervalSinceNow ?? 0,
      2,
      accuracy: 0.5,
      "a success re-arms at the base interval"
    )
    scheduler.stop()
  }

  func testTheArmedAttemptAdvancesOnEveryTick() {
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 0.4,
      monitorPath: false,
      refreshSession: { true },
      sync: {},
      jitterSource: { 0.999_999 }
    )
    scheduler.start()
    let first = scheduler.health().nextAttemptAt
    spin(0.6)
    let second = scheduler.health().nextAttemptAt
    XCTAssertNotNil(first)
    XCTAssertNotNil(second)
    XCTAssertGreaterThan(
      second?.timeIntervalSince1970 ?? 0,
      first?.timeIntervalSince1970 ?? 0,
      "a tick arms the next attempt rather than leaving a timestamp in the past"
    )
    scheduler.stop()
  }

  func testStopClearsTheArmedAttemptAndPublishes() {
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 4,
      monitorPath: false,
      refreshSession: { true },
      sync: {}
    )
    let published = LockBox<[KizunaSyncSyncHealth]>([])
    let unsubscribe = scheduler.onHealth { health in published.append(health) }
    scheduler.start()
    XCTAssertNotNil(scheduler.health().nextAttemptAt)
    scheduler.stop()
    XCTAssertNil(scheduler.health().nextAttemptAt)
    guard let last = published.snapshot().last else {
      XCTFail("stop() publishes a snapshot")
      return
    }
    XCTAssertNil(last.nextAttemptAt, "stop() publishes the disarmed snapshot")
    unsubscribe()
  }

  // MARK: - Busy slot: a poll tick is dropped, a stall counts

  func testAPollTickIsDroppedWhileARunIsInFlight() {
    let gate = Gate()
    let runs = LockBox<Int>(0)
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 0.3,
      monitorPath: false,
      refreshSession: { true },
      sync: {
        runs.increment()
        await gate.wait()
      },
      jitterSource: { 0.999_999 }
    )
    scheduler.start()
    // The start attempt takes the slot, and the first tick finds it busy and is dropped.
    spin(0.45)
    XCTAssertEqual(runs.snapshot(), 1)
    // No further tick can start a run, so anything after the release is a catch-up.
    scheduler.stop()
    gate.open()
    spin(0.4)
    XCTAssertEqual(runs.snapshot(), 1, "a plain poll tick books no catch-up run")
  }

  func testTwoTicksOnOneAttemptCountAFailureAndBookACatchUpRun() {
    let gate = Gate()
    let runs = LockBox<Int>(0)
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 0.3,
      monitorPath: false,
      refreshSession: { true },
      sync: {
        runs.increment()
        await gate.wait()
      },
      jitterSource: { 0.999_999 }
    )
    scheduler.start()
    // The start attempt takes the slot; the ticks at ~0.3 and ~0.6 find it busy, and the second calls it wedged.
    spin(0.8)
    XCTAssertEqual(scheduler.health().phase, .stalled)
    XCTAssertEqual(scheduler.health().consecutiveFailures, 1)
    scheduler.stop()
    gate.open()
    spin(0.5)
    XCTAssertEqual(runs.snapshot(), 2, "a stall books exactly one catch-up run")
  }

  // MARK: - Path monitor

  func testTheMonitorIsArmedOnStartAndReArmedAfterAToggle() {
    let monitor = FakePathMonitor()
    let runs = LockBox<Int>(0)
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 0,
      monitorPath: true,
      pathMonitor: monitor,
      refreshSession: { true },
      sync: { runs.increment() }
    )
    XCTAssertFalse(monitor.isStarted)
    scheduler.start()
    XCTAssertTrue(monitor.isStarted, "start() arms the monitor")
    XCTAssertEqual(scheduler.health().phase, .offline, "the gate is shut until the path reports")
    // The start attempt meets the shut gate before the path reports.
    spin(0.1)

    monitor.report(true)
    spin(0.3)
    XCTAssertEqual(runs.snapshot(), 1, "the first satisfied report resumes the loop")

    scheduler.monitorPath = false
    XCTAssertFalse(monitor.isStarted, "turning the gate off cancels the monitor")
    scheduler.monitorPath = true
    XCTAssertTrue(monitor.isStarted, "turning it back on re-arms the monitor")

    scheduler.stop()
    XCTAssertFalse(monitor.isStarted, "stop() cancels the monitor")
  }

  func testACancelledMonitorCannotShutTheGate() {
    let monitor = FakePathMonitor()
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 0,
      monitorPath: true,
      pathMonitor: monitor,
      refreshSession: { true },
      sync: {}
    )
    scheduler.start()
    monitor.report(true)
    scheduler.stop()
    monitor.report(false)
    XCTAssertNotEqual(
      scheduler.health().phase,
      .offline,
      "a late report from a cancelled monitor shuts no gate"
    )
  }

  func testTheForegroundSourceWakesTheLoopAndStopReleasesIt() async {
    let source = FakeForegroundSource()
    let runs = LockBox<Int>(0)
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 0,
      monitorPath: false,
      foregroundSource: source,
      refreshSession: { true },
      sync: { runs.increment() }
    )
    XCTAssertFalse(source.isStarted, "nothing is observed before start()")
    scheduler.start()
    XCTAssertTrue(source.isStarted)
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertEqual(runs.snapshot(), 1, "start runs one attempt")

    source.report()
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertEqual(runs.snapshot(), 2, "a return to the front syncs")

    scheduler.stop()
    XCTAssertFalse(source.isStarted, "stop() releases the registration")
    source.report()
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertEqual(runs.snapshot(), 2, "a late report from a released source wakes nothing")
  }

  func testTurningTheForegroundObserverOffInstallsNoSource() {
    let source = FakeForegroundSource()
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 0,
      monitorPath: false,
      observeForeground: false,
      foregroundSource: source,
      refreshSession: { true },
      sync: {}
    )
    scheduler.start()
    XCTAssertFalse(source.isStarted, "observeForeground false takes no source at all")
    scheduler.stop()
  }

  func testTheRealtimePortSubscribesToEveryConfiguredTable() async {
    let port = FakeRealtimeWakeup()
    let runs = LockBox<Int>(0)
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 0,
      monitorPath: false,
      observeForeground: false,
      realtime: port,
      realtimeTables: ["todos", "lists"],
      refreshSession: { true },
      sync: { runs.increment() }
    )
    scheduler.start()
    XCTAssertEqual(port.topics(), ["kizunasync:todos", "kizunasync:lists"])
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertEqual(runs.snapshot(), 1, "start runs one attempt")

    port.deliver()
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertEqual(runs.snapshot(), 2, "a realtime message is one sync")

    scheduler.stop()
    XCTAssertTrue(port.isCancelled, "stop() cancels the subscription")
  }

  func testARealtimePortWithNoTableIsNotSubscribed() {
    let port = FakeRealtimeWakeup()
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 0,
      monitorPath: false,
      observeForeground: false,
      realtime: port,
      refreshSession: { true },
      sync: {}
    )
    scheduler.start()
    XCTAssertTrue(port.topics().isEmpty, "a doorbell with nothing to watch holds no channel")
    scheduler.stop()
  }

  func testNeedsResetIsReadAfterEveryAttemptAndPublished() async {
    let blocked = LockBox<Bool>(false)
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 0,
      monitorPath: false,
      observeForeground: false,
      refreshSession: { true },
      sync: {},
      needsReset: { blocked.snapshot() }
    )
    XCTAssertFalse(scheduler.health().needsReset, "nothing is known before the first attempt")

    scheduler.wake(reason: .doorbell)
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertFalse(scheduler.health().needsReset)

    blocked.set(true)
    scheduler.wake(reason: .doorbell)
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertTrue(scheduler.health().needsReset, "the checkpoint's soft block reaches the snapshot")
    scheduler.stop()
  }

  func testASchedulerWithoutANeedsResetSourceReportsFalse() async {
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 0,
      monitorPath: false,
      observeForeground: false,
      refreshSession: { true },
      sync: {}
    )
    scheduler.wake(reason: .doorbell)
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertFalse(scheduler.health().needsReset)
    scheduler.stop()
  }

  // MARK: - Client

  func testSyncDefaultsToTheClient() async {
    let engine = EventEngine()
    let scheduler = KizunaSyncScheduler(
      client: KizunaSyncClient(engine: engine),
      pollInterval: 0,
      monitorPath: false,
      observeForeground: false,
      refreshSession: { true }
    )
    scheduler.wake(reason: .doorbell)
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertEqual(engine.syncCount, 1, "a scheduler given no sync runs the client's")
    scheduler.stop()
  }

  func testStartRunsOneAttemptRightAway() async {
    let runs = LockBox<Int>(0)
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 60,
      monitorPath: false,
      observeForeground: false,
      refreshSession: { true },
      sync: { runs.increment() }
    )
    scheduler.start()
    try? await Task.sleep(nanoseconds: 300_000_000)
    XCTAssertEqual(runs.snapshot(), 1, "the first sync does not wait for the first tick")
    scheduler.stop()
  }

  func testAQueueDepthAboveZeroWakesTheLoopAndZeroDoesNot() async {
    let engine = EventEngine()
    let runs = LockBox<Int>(0)
    let scheduler = KizunaSyncScheduler(
      client: KizunaSyncClient(engine: engine),
      pollInterval: 0,
      monitorPath: false,
      observeForeground: false,
      refreshSession: { true },
      sync: { runs.increment() }
    )
    scheduler.start()
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertTrue(engine.isSubscribed, "start subscribes to the client's events")
    XCTAssertEqual(runs.snapshot(), 1)

    engine.emit(.queueDepth(depth: 0))
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertEqual(runs.snapshot(), 1, "an empty outbox has nothing to push")

    engine.emit(.queueDepth(depth: 1))
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertEqual(runs.snapshot(), 2, "a local write syncs without waiting for a tick")
    scheduler.stop()
  }

  func testStopReleasesTheEventSubscription() async {
    let engine = EventEngine()
    let runs = LockBox<Int>(0)
    let scheduler = KizunaSyncScheduler(
      client: KizunaSyncClient(engine: engine),
      pollInterval: 0,
      monitorPath: false,
      observeForeground: false,
      refreshSession: { true },
      sync: { runs.increment() }
    )
    scheduler.start()
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertTrue(engine.releasedIds.isEmpty, "the subscription lives while the scheduler runs")

    scheduler.stop()
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertEqual(engine.releasedIds, [EventEngine.subscriptionId], "stop releases the subscription start made")

    engine.emit(.queueDepth(depth: 1))
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertEqual(runs.snapshot(), 1, "an event delivered after stop wakes nothing")
  }

  func testASubscriptionTheClientRefusesReachesOnError() async {
    let failures = LockBox<[String]>([])
    let scheduler = KizunaSyncScheduler(
      client: KizunaSyncClient(engine: EventEngine(refusingSubscriptions: true)),
      pollInterval: 0,
      monitorPath: false,
      observeForeground: false,
      refreshSession: { true },
      sync: {},
      onError: { error in failures.append((error as? KizunaSyncError)?.code ?? "uncoded") }
    )
    scheduler.start()
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertEqual(failures.snapshot(), ["ENGINE_UNAVAILABLE"])
    scheduler.stop()
  }

  // MARK: - Settings

  /**
   * The app reassigns a setting from its own thread while a run reads it on
   * another. Run under the thread sanitizer, an unguarded setting reports the
   * data race.
   */
  func testSettingsCanBeReassignedWhileRunsReadThem() async {
    let runs = LockBox<Int>(0)
    let scheduler = KizunaSyncScheduler(
      client: makeClient(),
      pollInterval: 0,
      monitorPath: false,
      observeForeground: false,
      refreshSession: { true },
      sync: { runs.increment() }
    )
    await withTaskGroup(of: Void.self) { group in
      for index in 0..<400 {
        group.addTask {
          switch index % 6 {
          case 0: scheduler.sync = { runs.increment() }
          case 1: scheduler.refreshSession = { true }
          case 2: scheduler.onError = { _ in }
          case 3: scheduler.pollInterval = 0
          case 4: scheduler.monitorPath = false
          default: scheduler.wake()
          }
        }
      }
    }
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertGreaterThan(runs.snapshot(), 0)
    XCTAssertEqual(scheduler.pollInterval, 0)
    XCTAssertFalse(scheduler.monitorPath)
    scheduler.stop()
  }

  /// Runs the main run loop so the scheduler's timer fires inside the test.
  private func spin(_ seconds: TimeInterval) {
    RunLoop.current.run(until: Date().addingTimeInterval(seconds))
  }
}

/**
 * Hands out one event subscription, keeps its observer, counts `sync()`, and
 * records every release, without a Rust engine behind it. The observer stays
 * after a release, so a test can deliver an event the engine had already
 * dispatched.
 */
private final class EventEngine: KizunaSyncFfi.KizunaSyncEngine, @unchecked Sendable {
  static let subscriptionId: UInt64 = 7

  private let refusesSubscriptions: Bool
  private let lock = NSLock()
  private var observer: EventObserver?
  private var released: [UInt64] = []
  private var syncs = 0

  init(refusingSubscriptions: Bool = false) {
    self.refusesSubscriptions = refusingSubscriptions
    super.init(noHandle: KizunaSyncFfi.KizunaSyncEngine.NoHandle())
  }

  required init(unsafeFromHandle handle: UInt64) {
    fatalError("EventEngine is never lifted from a handle")
  }

  var isSubscribed: Bool {
    lock.withLock { observer != nil }
  }

  var releasedIds: [UInt64] {
    lock.withLock { released }
  }

  var syncCount: Int {
    lock.withLock { syncs }
  }

  override func subscribe(observer: EventObserver) throws -> UInt64 {
    if refusesSubscriptions {
      throw KizunaSyncFfiError.Engine(code: "ENGINE_UNAVAILABLE", msg: "no engine")
    }
    lock.withLock { self.observer = observer }
    return Self.subscriptionId
  }

  override func unsubscribe(subscriptionId: UInt64) throws {
    lock.withLock { released.append(subscriptionId) }
  }

  override func sync() throws {
    lock.withLock { syncs += 1 }
  }

  /// Deliver one event the way the engine's delivery thread does.
  func emit(_ event: KizunaSyncEngineEvent) {
    let current = lock.withLock { observer }
    current?.onEvent(event: event)
  }
}

/// A client whose engine answers the scheduler's own calls without Rust behind it.
private func makeClient() -> KizunaSyncClient {
  KizunaSyncClient(engine: EventEngine())
}

/// Stands in for the platform notification so the foreground seam is observable
/// without a running application.
private final class FakeForegroundSource: KizunaSyncForegroundSource, @unchecked Sendable {
  private let lock = NSLock()
  private var onForeground: (@Sendable () -> Void)?

  var isStarted: Bool {
    lock.lock()
    defer { lock.unlock() }
    return onForeground != nil
  }

  func start(onForeground: @escaping @Sendable () -> Void) {
    lock.lock()
    self.onForeground = onForeground
    lock.unlock()
  }

  func stop() {
    lock.lock()
    onForeground = nil
    lock.unlock()
  }

  func report() {
    lock.lock()
    let handler = onForeground
    lock.unlock()
    handler?()
  }
}

/// Stands in for the app's own Supabase channel.
private final class FakeRealtimeWakeup: KizunaSyncRealtimeWakeup, @unchecked Sendable {
  private let lock = NSLock()
  private var subscribedTopics: [String] = []
  private var onWake: (@Sendable () -> Void)?
  private var cancelled = false

  func topics() -> [String] {
    lock.lock()
    defer { lock.unlock() }
    return subscribedTopics
  }

  var isCancelled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled
  }

  func subscribe(
    topics: [String],
    onWake: @escaping @Sendable () -> Void
  ) -> KizunaSyncRealtimeSubscription {
    lock.lock()
    subscribedTopics = topics
    self.onWake = onWake
    cancelled = false
    lock.unlock()
    return FakeRealtimeSubscription(port: self)
  }

  func deliver() {
    lock.lock()
    let handler = onWake
    lock.unlock()
    handler?()
  }

  fileprivate func markCancelled() {
    lock.lock()
    cancelled = true
    onWake = nil
    lock.unlock()
  }
}

private final class FakeRealtimeSubscription: KizunaSyncRealtimeSubscription {
  private let port: FakeRealtimeWakeup

  init(port: FakeRealtimeWakeup) {
    self.port = port
  }

  func cancel() {
    port.markCancelled()
  }
}

/// Stands in for the system monitor so arming and re-arming are observable.
private final class FakePathMonitor: KizunaSyncPathMonitor, @unchecked Sendable {
  private let lock = NSLock()
  private var onSatisfied: (@Sendable (Bool) -> Void)?

  var isStarted: Bool {
    lock.lock()
    defer { lock.unlock() }
    return onSatisfied != nil
  }

  func start(onSatisfied: @escaping @Sendable (Bool) -> Void) {
    lock.lock()
    self.onSatisfied = onSatisfied
    lock.unlock()
  }

  func cancel() {
    lock.lock()
    onSatisfied = nil
    lock.unlock()
  }

  func report(_ satisfied: Bool) {
    lock.lock()
    let handler = onSatisfied
    lock.unlock()
    handler?(satisfied)
  }
}

/// Holds an attempt in flight until the test releases it.
private final class Gate: @unchecked Sendable {
  private let lock = NSLock()
  private var released = false

  func open() {
    lock.lock()
    released = true
    lock.unlock()
  }

  func wait() async {
    while !isOpen() {
      try? await Task.sleep(nanoseconds: 5_000_000)
    }
  }

  /// Synchronous, so `wait()` never takes the lock from an async context.
  private func isOpen() -> Bool {
    lock.withLock { released }
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

  func set(_ next: T) {
    lock.lock()
    value = next
    lock.unlock()
  }

  func append(_ item: String) where T == [String] {
    lock.lock()
    value.append(item)
    lock.unlock()
  }

  func append(_ item: KizunaSyncSyncHealth) where T == [KizunaSyncSyncHealth] {
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

  func decrement() where T == Int {
    lock.lock()
    value -= 1
    lock.unlock()
  }

  func updateMax(_ observed: Int) where T == Int {
    lock.lock()
    value = max(value, observed)
    lock.unlock()
  }
}

#endif
