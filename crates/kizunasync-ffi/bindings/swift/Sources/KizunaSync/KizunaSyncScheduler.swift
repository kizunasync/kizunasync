import Foundation
#if canImport(Network)
import Network
#endif
#if canImport(KizunaSyncFfi)
import KizunaSyncFfi
#endif

/// Why an out-of-band sync was requested.
public enum KizunaSyncWakeReason: String, Sendable {
  /// The periodic tick.
  case poll
  /// The app came back to the foreground.
  case foreground
  /// The network path became satisfied.
  case path
  /// The app rang the doorbell, usually from a realtime message.
  case doorbell
  /// A local write left the client's outbox with something to push.
  case localWrite
  /// The scheduler started.
  case start
}

/// What the automatic loop is doing right now.
public enum KizunaSyncSyncPhase: String, Sendable {
  /// Nothing in flight and no failure streak.
  case idle
  /// An attempt is running.
  case syncing
  /// The last attempt failed and the next one is armed further out.
  case backoff
  /// The attempt in flight has occupied the slot for two ticks.
  case stalled
  /// The path gate is shut.
  case offline
}

/// The failure the last attempt reported.
public struct KizunaSyncSyncHealthError: Equatable, Sendable {
  /// The stable catalog code when the failure carried one, else nil.
  public let code: String?
  /// The failure text.
  public let message: String
  /// When the client recorded the failure.
  public let at: Date

  /// Record one failure.
  public init(code: String?, message: String, at: Date) {
    self.code = code
    self.message = message
    self.at = at
  }
}

/// An observable snapshot of the automatic loop.
public struct KizunaSyncSyncHealth: Equatable, Sendable {
  /// What the loop is doing right now.
  public var phase: KizunaSyncSyncPhase
  /// How many attempts have failed in a row.
  public var consecutiveFailures: Int
  /// When the next armed attempt is due; nil when none is armed.
  public var nextAttemptAt: Date?
  /// When the attempt now in flight started; nil when idle.
  public var attemptStartedAt: Date?
  /// When the last attempt that settled successfully finished; nil before the first.
  public var lastSuccessAt: Date?
  /// The failure the last attempt reported; nil after a success.
  public var lastError: KizunaSyncSyncHealthError?
  /**
   * Whether the server has blocked this client until `reset()` runs. It is the
   * checkpoint's soft block, read through the `needsReset` source the app
   * passed; a scheduler built without one reports false.
   */
  public var needsReset: Bool = false
}

/**
 * The network-path source the scheduler gates on. `KizunaSyncNetworkPathMonitor`
 * backs it with `NWPathMonitor`; a test injects its own so arming and
 * re-arming are observable without a live path.
 */
public protocol KizunaSyncPathMonitor: AnyObject {
  /// Begin reporting. `onSatisfied` is called with the current state and again
  /// on every change.
  func start(onSatisfied: @escaping @Sendable (Bool) -> Void)
  /// Stop reporting. Idempotent.
  func cancel()
}

#if canImport(Network)
/**
 * `NWPathMonitor` behind the scheduler's path gate. Each `start` arms a fresh
 * monitor, because a cancelled `NWPathMonitor` cannot be restarted.
 */
public final class KizunaSyncNetworkPathMonitor: KizunaSyncPathMonitor, @unchecked Sendable {
  private let lock = NSLock()
  private var monitor: NWPathMonitor?

  /// Build a monitor over the system's path.
  public init() {}

  /// Arm a fresh `NWPathMonitor` and report every path change through it.
  public func start(onSatisfied: @escaping @Sendable (Bool) -> Void) {
    cancel()
    let armed = NWPathMonitor()
    /**
     * `cancel()` does not retract a block already dispatched on the monitor's
     * queue, so the handler checks that this monitor is still the armed one.
     * Without it a late delivery shuts a gate nothing can reopen.
     */
    armed.pathUpdateHandler = { [weak self, weak armed] path in
      guard let self, let armed, self.isArmed(armed) else { return }
      onSatisfied(path.status == .satisfied)
    }
    lock.lock()
    monitor = armed
    lock.unlock()
    armed.start(queue: DispatchQueue(label: "com.kizunasync.kizunasync.path"))
  }

  /// Cancel the armed monitor, if any. Idempotent.
  public func cancel() {
    lock.lock()
    let armed = monitor
    monitor = nil
    lock.unlock()
    armed?.cancel()
  }

  private func isArmed(_ other: NWPathMonitor) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return monitor === other
  }
}
#endif

#if canImport(KizunaSyncFfi)

private let kizunasyncMaxBackoff: TimeInterval = 30
private let kizunasyncStalledAttemptTicks = 2

/**
 * Host scheduler over one client: it syncs once at start, on its own timer, on
 * every local write to that client, and on the wake sources below.
 * Connectivity and foreground are OS concerns. The doorbell is a callback the
 * app wires from supabase-swift realtime. Refresh the user JWT **before**
 * `sync()` so a backgrounded session does not poll with a dead Bearer.
 */
public final class KizunaSyncScheduler: @unchecked Sendable {
  /// Assigning restarts a running timer, so a new interval takes effect at once.
  public var pollInterval: TimeInterval {
    get { locked { storedPollInterval } }
    set {
      locked { storedPollInterval = newValue }
      restartTimer()
    }
  }

  /**
   * Assigning restarts a running timer, so the next wake is a full interval
   * away from the swap rather than firing on the old schedule.
   */
  public var refreshSession: () async -> Bool {
    get { locked { storedRefreshSession } }
    set {
      locked { storedRefreshSession = newValue }
      restartTimer()
    }
  }

  /// The work of one run: the client's `sync()` unless the app passed its own.
  public var sync: () async throws -> Void {
    get { locked { storedSync } }
    set { locked { storedSync = newValue } }
  }

  /**
   * Assigning on a running scheduler arms or cancels the monitor at once.
   * Turning it off reopens the gate, so "ungated" holds from that moment.
   */
  public var monitorPath: Bool {
    get { locked { storedMonitorPath } }
    set {
      locked { storedMonitorPath = newValue }
      applyMonitorPath()
    }
  }

  /**
   * Receives whatever `sync` threw, and a local-write subscription the client
   * refused. Unset, a failed run is dropped and the next wake tries again: the
   * behavior an offline device needs.
   */
  public var onError: ((Error) -> Void)? {
    get { locked { storedOnError } }
    set { locked { storedOnError = newValue } }
  }

  private let client: KizunaSyncClient
  private let pathMonitor: KizunaSyncPathMonitor?
  private let foregroundSource: KizunaSyncForegroundSource?
  private let realtime: KizunaSyncRealtimeWakeup?
  private let realtimeTopics: [String]
  private let needsResetSource: (@Sendable () async -> Bool)?
  private let jitterSource: @Sendable () -> Double
  private var inFlight = false
  private var trailing = false
  /// Open until the monitor starts; the monitor owns the gate while it runs.
  private var pathSatisfied = true
  private let inFlightLock = NSLock()
  private let healthLock = NSLock()
  private var consecutiveFailures = 0
  private var attemptStartedAt: Date?
  private var lastSuccessAt: Date?
  private var lastError: KizunaSyncSyncHealthError?
  private var isAttemptStalled = false
  private var stallTicks = 0
  private var nextAttemptAt: Date?
  private var needsReset = false
  private var healthListeners: [UInt64: @Sendable (KizunaSyncSyncHealth) -> Void] = [:]
  private var nextHealthId: UInt64 = 1

  /**
   * Guards the settings and the lifecycle fields below: the app assigns them,
   * and `start`, `stop`, and every run read them, each from whichever thread it
   * happens to be on.
   */
  private let stateLock = NSLock()
  private var storedPollInterval: TimeInterval
  private var storedRefreshSession: () async -> Bool
  private var storedSync: () async throws -> Void
  private var storedMonitorPath: Bool
  private var storedOnError: ((Error) -> Void)?
  private var timer: Timer?
  private var running = false
  private var monitorArmed = false
  private var foregroundArmed = false
  private var realtimeSubscription: KizunaSyncRealtimeSubscription?
  private var localWritesGeneration: UInt64 = 0
  private var releaseLocalWrites: (@Sendable () -> Void)?

  /**
   * `client` is the one the scheduler syncs and watches: a local write to it
   * wakes a run, and `sync` left nil runs its `sync()`. Pass `sync` to run more
   * than that, such as a refresh of what the screen shows.
   * `pathMonitor` left nil takes the system monitor. An app then gates on
   * connectivity by default; a test injects its own source.
   * `observeForeground` left true takes the platform's did-become-active
   * notification. A backgrounded app then syncs on the way back in; pass false,
   * or a `foregroundSource` of your own, to take that over. `realtime` is the
   * doorbell the app's own Supabase channel rings: the scheduler subscribes to
   * `kizunasync:<table>` for each of `realtimeTables` and syncs on every message.
   * `needsReset` is read after each attempt and published on the health
   * snapshot; wire it to `client.checkpoint().softBlocked`. `jitterSource`
   * draws the jitter fraction in `[0, 1)`; pass a constant in tests to make the
   * armed delay deterministic.
   */
  public init(
    client: KizunaSyncClient,
    pollInterval: TimeInterval = 15,
    monitorPath: Bool = true,
    pathMonitor: KizunaSyncPathMonitor? = nil,
    observeForeground: Bool = true,
    foregroundSource: KizunaSyncForegroundSource? = nil,
    realtime: KizunaSyncRealtimeWakeup? = nil,
    realtimeTables: [String] = [],
    refreshSession: @escaping () async -> Bool,
    sync: (() async throws -> Void)? = nil,
    onError: ((Error) -> Void)? = nil,
    jitterSource: @Sendable @escaping () -> Double = { Double.random(in: 0..<1) },
    needsReset: (@Sendable () async -> Bool)? = nil
  ) {
    self.client = client
    self.storedPollInterval = pollInterval
    self.storedMonitorPath = monitorPath
    self.pathMonitor = pathMonitor ?? Self.systemPathMonitor()
    self.foregroundSource = observeForeground
      ? (foregroundSource ?? KizunaSyncNotificationForegroundSource())
      : nil
    self.realtime = realtime
    self.realtimeTopics = realtimeTables.map { "kizunasync:\($0)" }
    self.needsResetSource = needsReset
    self.storedRefreshSession = refreshSession
    self.storedSync = sync ?? { try await client.sync() }
    self.storedOnError = onError
    self.jitterSource = jitterSource
  }

  private static func systemPathMonitor() -> KizunaSyncPathMonitor? {
#if canImport(Network)
    return KizunaSyncNetworkPathMonitor()
#else
    return nil
#endif
  }

  /**
   * Arm the poll timer, the path monitor, the foreground source, the realtime
   * doorbell and the client's local-write events, then run one attempt, so the
   * first pull does not wait for the first tick. Idempotent.
   */
  public func start() {
    stateLock.lock()
    if running {
      stateLock.unlock()
      return
    }
    running = true
    stateLock.unlock()
    restartTimer()
    startPathMonitor()
    startForegroundSource()
    startRealtime()
    startLocalWrites()
    wake(reason: .start)
  }

  /// Disarm every source and publish the disarmed health.
  public func stop() {
    stateLock.lock()
    running = false
    stateLock.unlock()
    restartTimer()
    stopPathMonitor()
    stopForegroundSource()
    stopRealtime()
    stopLocalWrites()
    setPathSatisfied(true)
  }

  /// Request an attempt now. Every reason other than `poll` is fresh external
  /// evidence, so it clears the failure streak first.
  public func wake(reason: KizunaSyncWakeReason = .doorbell) {
    if reason != .poll {
      clearFailures()
    }
    Task { await self.run(reason: reason) }
  }

  /// The loop's current state.
  public func health() -> KizunaSyncSyncHealth {
    snapshotHealth()
  }

  /// Observe every transition. The handler is called once with the current
  /// snapshot. Returns an unsubscribe function.
  public func onHealth(
    _ handler: @escaping @Sendable (KizunaSyncSyncHealth) -> Void
  ) -> () -> Void {
    healthLock.lock()
    let id = nextHealthId
    nextHealthId += 1
    healthListeners[id] = handler
    healthLock.unlock()
    handler(snapshotHealth())
    return { [weak self] in
      self?.healthLock.lock()
      self?.healthListeners.removeValue(forKey: id)
      self?.healthLock.unlock()
    }
  }

  /// Call from SwiftUI `scenePhase == .active` (or UIKit foreground).
  public func notifyForeground() {
    wake(reason: .foreground)
  }

  /// Call when the app tracks reachability itself instead of gating on the monitor.
  public func notifyOnline() {
    wake(reason: .path)
  }

  /**
   * `Timer.invalidate()` is only legal on the thread the timer was installed
   * on, and this one lives on the main run loop, so every arm and disarm hops
   * there first. It is also the single path that disarms: `stop()` clears
   * `running` and calls this, and `installTimer` then installs nothing.
   */
  private func restartTimer() {
    if Thread.isMainThread {
      installTimer()
    } else {
      DispatchQueue.main.async { [weak self] in self?.installTimer() }
    }
  }

  /**
   * Main thread only. It re-reads `running` under the lock: a `stop()` that
   * landed while the hop was in flight wins, and no timer survives it. The
   * timer fires once. Every tick arms the next one itself, so jitter and
   * backoff are recomputed per arm.
   */
  private func installTimer() {
    var armedAt: Date?
    stateLock.lock()
    timer?.invalidate()
    timer = nil
    if running, storedPollInterval > 0 {
      let delay = armDelay(interval: storedPollInterval)
      armedAt = Date().addingTimeInterval(delay)
      let armed = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
        guard let self, self.isRunning() else { return }
        self.tick()
      }
      RunLoop.main.add(armed, forMode: .common)
      timer = armed
    }
    stateLock.unlock()
    healthLock.lock()
    nextAttemptAt = armedAt
    healthLock.unlock()
    publishHealth()
  }

  /**
   * Arm the next tick BEFORE the attempt. Nothing the attempt does, including
   * never settling, is then allowed to decide whether there is a next tick.
   */
  private func tick() {
    restartTimer()
    Task { await self.run(reason: .poll) }
  }

  /**
   * Full jitter in `[delay/2, delay]` so many devices de-sync rather than
   * stampede a recovering server. The streak grows the delay exponentially up
   * to 30 seconds and never below the interval the caller configured, so a
   * deliberately slow poll is never sped up by a failure.
   */
  private func armDelay(interval: TimeInterval) -> TimeInterval {
    healthLock.lock()
    let failures = consecutiveFailures
    healthLock.unlock()
    let ceiling = max(interval, kizunasyncMaxBackoff)
    let grown = failures > 0
      ? min(interval * pow(2, Double(failures)), ceiling)
      : interval
    return grown / 2 + jitterSource() * (grown / 2)
  }

  private func startPathMonitor() {
    guard monitorPath, let monitor = pathMonitor else { return }
    stateLock.lock()
    if !running || monitorArmed {
      stateLock.unlock()
      return
    }
    monitorArmed = true
    stateLock.unlock()
    setPathSatisfied(false)
    monitor.start { [weak self] satisfied in
      guard let self, self.isMonitorArmed() else { return }
      self.reportPath(satisfied)
    }
  }

  private func stopPathMonitor() {
    stateLock.lock()
    let armed = monitorArmed
    monitorArmed = false
    stateLock.unlock()
    guard armed else { return }
    pathMonitor?.cancel()
  }

  private func isMonitorArmed() -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return monitorArmed
  }

  private func startForegroundSource() {
    guard let source = foregroundSource else { return }
    stateLock.lock()
    if !running || foregroundArmed {
      stateLock.unlock()
      return
    }
    foregroundArmed = true
    stateLock.unlock()
    source.start { [weak self] in
      guard let self, self.isForegroundArmed() else { return }
      self.notifyForeground()
    }
  }

  private func stopForegroundSource() {
    stateLock.lock()
    let armed = foregroundArmed
    foregroundArmed = false
    stateLock.unlock()
    guard armed else { return }
    foregroundSource?.stop()
  }

  private func isForegroundArmed() -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return foregroundArmed
  }

  /**
   * Subscribe the doorbell to every configured table's topic. A port with no
   * table to watch is not subscribed at all, because a subscription to nothing
   * would hold a channel open for messages that cannot arrive.
   */
  private func startRealtime() {
    guard let realtime, !realtimeTopics.isEmpty else { return }
    stateLock.lock()
    if !running || realtimeSubscription != nil {
      stateLock.unlock()
      return
    }
    stateLock.unlock()
    let handle = realtime.subscribe(topics: realtimeTopics) { [weak self] in
      self?.wake(reason: .doorbell)
    }
    stateLock.lock()
    let duplicate = realtimeSubscription != nil || !running
    if !duplicate {
      realtimeSubscription = handle
    }
    stateLock.unlock()
    if duplicate {
      handle.cancel()
    }
  }

  private func stopRealtime() {
    stateLock.lock()
    let handle = realtimeSubscription
    realtimeSubscription = nil
    stateLock.unlock()
    handle?.cancel()
  }

  /**
   * Subscribe to the client's queue depth: a local write then syncs without
   * waiting for the next tick. `on` answers asynchronously, so each start takes
   * a generation: a subscription that resolves after `stop()` or a later
   * `start()` is released at once, and its events wake nothing. A refused
   * subscription reaches `onError` while the timer and the other sources keep
   * the loop going.
   */
  private func startLocalWrites() {
    stateLock.lock()
    localWritesGeneration &+= 1
    let generation = localWritesGeneration
    stateLock.unlock()
    Task { [self] in
      do {
        let release = try await self.client.on { [weak self] event in
          guard case .queueDepth(let depth) = event, depth > 0 else { return }
          guard let self, self.isLocalWritesGeneration(generation) else { return }
          self.wake(reason: .localWrite)
        }
        self.adoptLocalWrites(release, generation: generation)
      } catch {
        if self.isLocalWritesGeneration(generation) {
          self.onError?(error)
        }
      }
    }
  }

  private func adoptLocalWrites(_ release: @escaping @Sendable () -> Void, generation: UInt64) {
    stateLock.lock()
    let isCurrent = localWritesGeneration == generation && releaseLocalWrites == nil
    if isCurrent {
      releaseLocalWrites = release
    }
    stateLock.unlock()
    if !isCurrent {
      release()
    }
  }

  private func stopLocalWrites() {
    stateLock.lock()
    localWritesGeneration &+= 1
    let release = releaseLocalWrites
    releaseLocalWrites = nil
    stateLock.unlock()
    release?()
  }

  private func isLocalWritesGeneration(_ generation: UInt64) -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return localWritesGeneration == generation
  }

  /**
   * Turning the flag on a running scheduler arms the monitor; turning it off
   * cancels it and reopens the gate, because an app that asked for no gate
   * must not stay held offline.
   */
  private func applyMonitorPath() {
    stateLock.lock()
    let isRunning = running
    stateLock.unlock()
    guard isRunning else { return }
    if monitorPath {
      startPathMonitor()
    } else {
      stopPathMonitor()
      reportPath(true)
    }
  }

  /**
   * The path gate, and the seam a host test drives in place of a live monitor.
   * An unsatisfied path holds every run; the first satisfied report after that
   * resumes the loop and wakes one.
   */
  internal func reportPath(_ satisfied: Bool) {
    if setPathSatisfied(satisfied) {
      wake(reason: .path)
    }
  }

  private func run(reason: KizunaSyncWakeReason) async {
    guard isPathSatisfied() else {
      publishHealth()
      return
    }
    guard beginRun(reason: reason) else { return }
    markAttemptStarted()
    var failure: Error?
    var attempted = false
    let hasSession = await refreshSession()
    if hasSession {
      attempted = true
      do {
        try await sync()
      } catch {
        failure = error
        onError?(error)
      }
    }
    await readNeedsReset()
    finishRun(failure: failure, attempted: attempted)
  }

  /**
   * Read the checkpoint's soft block after the attempt, so a `RESET_REQUIRED`
   * the server just sent reaches the snapshot the UI renders.
   */
  private func readNeedsReset() async {
    guard let needsResetSource else { return }
    storeNeedsReset(await needsResetSource())
  }

  /// The lock is taken synchronously: `NSLock` is unavailable from an async
  /// context and is an error in the Swift 6 language mode.
  private func storeNeedsReset(_ blocked: Bool) {
    healthLock.lock()
    needsReset = blocked
    healthLock.unlock()
  }

  /**
   * Answers whether this wake owns the in-flight slot. Busy, a wake books the
   * one catch-up run because it is fresh evidence the run under way may
   * predate it, while a plain poll tick is dropped: booking one would turn a
   * sync that merely takes longer than the interval into a back-to-back loop.
   */
  private func beginRun(reason: KizunaSyncWakeReason) -> Bool {
    inFlightLock.lock()
    if !inFlight {
      inFlight = true
      inFlightLock.unlock()
      return true
    }
    if reason != .poll {
      trailing = true
    }
    inFlightLock.unlock()
    if reason == .poll {
      notePollTickOnBusyAttempt()
    }
    return false
  }

  /**
   * Two ticks on one attempt call it wedged: the eventual settlement is not
   * progress, so it counts a failure, books one catch-up run, and re-arms with
   * the grown backoff. It does not free the slot, because the request is still
   * out there.
   */
  private func notePollTickOnBusyAttempt() {
    healthLock.lock()
    stallTicks += 1
    let crossed = stallTicks >= kizunasyncStalledAttemptTicks && !isAttemptStalled
    if crossed {
      isAttemptStalled = true
      consecutiveFailures += 1
    }
    healthLock.unlock()
    guard crossed else { return }
    inFlightLock.lock()
    trailing = true
    inFlightLock.unlock()
    restartTimer()
  }

  /// A `KizunaSyncError` carries its catalog code across; anything else the app's
  /// `sync` closure threw has none, so the snapshot reports the text alone.
  private func effectiveHealthError(_ error: Error) -> KizunaSyncSyncHealthError {
    if let kizunasync = error as? KizunaSyncError {
      return KizunaSyncSyncHealthError(code: kizunasync.code, message: kizunasync.message, at: Date())
    }
    return KizunaSyncSyncHealthError(code: nil, message: String(describing: error), at: Date())
  }

  private func snapshotHealth() -> KizunaSyncSyncHealth {
    let offline = !isPathSatisfied()
    healthLock.lock()
    defer { healthLock.unlock() }
    let phase: KizunaSyncSyncPhase
    if offline {
      phase = .offline
    } else if attemptStartedAt != nil {
      phase = isAttemptStalled ? .stalled : .syncing
    } else if consecutiveFailures > 0 {
      phase = .backoff
    } else {
      phase = .idle
    }
    return KizunaSyncSyncHealth(
      phase: phase,
      consecutiveFailures: consecutiveFailures,
      nextAttemptAt: nextAttemptAt,
      attemptStartedAt: attemptStartedAt,
      lastSuccessAt: lastSuccessAt,
      lastError: lastError,
      needsReset: needsReset
    )
  }

  private func publishHealth() {
    let snapshot = snapshotHealth()
    healthLock.lock()
    let listeners = Array(healthListeners.values)
    healthLock.unlock()
    for listener in listeners {
      listener(snapshot)
    }
  }

  private func clearFailures() {
    healthLock.lock()
    let moved = consecutiveFailures > 0 || isAttemptStalled || lastError != nil
    consecutiveFailures = 0
    isAttemptStalled = false
    stallTicks = 0
    lastError = nil
    healthLock.unlock()
    /// The streak decides the armed delay, so clearing it re-arms at the base.
    if moved {
      restartTimer()
    } else {
      publishHealth()
    }
  }

  private func markAttemptStarted() {
    healthLock.lock()
    attemptStartedAt = Date()
    isAttemptStalled = false
    stallTicks = 0
    healthLock.unlock()
    publishHealth()
  }

  private func finishRun(failure: Error?, attempted: Bool) {
    healthLock.lock()
    attemptStartedAt = nil
    isAttemptStalled = false
    stallTicks = 0
    var streakMoved = false
    if attempted {
      if let failure {
        consecutiveFailures += 1
        lastError = effectiveHealthError(failure)
        streakMoved = true
      } else {
        streakMoved = consecutiveFailures > 0
        consecutiveFailures = 0
        lastSuccessAt = Date()
        lastError = nil
      }
    }
    healthLock.unlock()

    inFlightLock.lock()
    inFlight = false
    let catchUp = trailing
    trailing = false
    inFlightLock.unlock()

    if catchUp {
      /**
       * The catch-up run is owed to a wake or a stall, not to fresh evidence of
       * its own, so it runs without clearing the streak.
       */
      restartTimer()
      Task { await self.run(reason: .doorbell) }
      return
    }
    if streakMoved {
      restartTimer()
    } else {
      publishHealth()
    }
  }

  private func isRunning() -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return running
  }

  /// `stateLock` is not reentrant, so a caller that already holds it reads the stored field instead.
  private func locked<T>(_ body: () -> T) -> T {
    stateLock.lock()
    defer { stateLock.unlock() }
    return body()
  }

  private func isPathSatisfied() -> Bool {
    inFlightLock.lock()
    defer { inFlightLock.unlock() }
    return pathSatisfied
  }

  /// Answers true when the path just came back, which is the caller's cue to wake a run.
  @discardableResult
  private func setPathSatisfied(_ satisfied: Bool) -> Bool {
    inFlightLock.lock()
    defer { inFlightLock.unlock() }
    let resumed = satisfied && !pathSatisfied
    pathSatisfied = satisfied
    return resumed
  }
}

#endif
