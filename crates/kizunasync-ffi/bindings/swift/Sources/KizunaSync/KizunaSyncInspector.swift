import Foundation
#if canImport(KizunaSyncFfi)

/// One coherent read of the local command queue.
public struct KizunaSyncInspectorSnapshot {
  /// The head of the outbox, oldest first.
  public let queued: [[String: Any]]
  /// How many mutations are still queued, including the ones past the page.
  public let depth: Int
  /// The most recent mutation the engine recorded, or nil before the first.
  public let lastMutationId: String?
  /// The pull cursor the next pull resumes from.
  public let cursor: String
  /// The identity this client is registered under. `reset()` mints a new one.
  public let clientId: String
}

/// Which side of the server's answer produced a verdict.
public enum KizunaSyncInspectorVerdictKind: String, Sendable {
  /// The server refused one mutation on its own.
  case rejected
  /// The server refused a whole atomic batch and blamed one member.
  case aborted
  /// A peer's write won one column and this device's value was replaced.
  case overwritten
}

/// One entry of the ring: a server refusal, or a column a peer took.
public struct KizunaSyncInspectorVerdict: Equatable, Sendable {
  /// The refused mutation, the member the server blamed for the batch, or the
  /// peer write that won the column.
  public let mutationId: String
  /// Which of the three the entry is.
  public let kind: KizunaSyncInspectorVerdictKind
  /// The server's reason code, or `"<table>.<column>"` for an overwrite: the
  /// conflict mode is a configuration fact rather than a verdict.
  public let reason: String
  /// When the client recorded the verdict.
  public let at: Date
}

private let kizunasyncVerdictRingCap = 50

/**
 * Devtools over one client: the queue snapshot the engine answers with, plus a
 * bounded ring of the refusals its event bus reported. Refusals are otherwise
 * transient, so the ring is the only place a UI can read them back.
 *
 * `KizunaSyncClient.inspector()` builds and memoizes one per client.
 */
public final class KizunaSyncInspector: @unchecked Sendable {
  private let client: KizunaSyncClient
  private let now: @Sendable () -> Date
  private let lock = NSLock()
  private var ring: [KizunaSyncInspectorVerdict] = []
  private var listeners: [UInt64: () -> Void] = [:]
  private var nextListenerId: UInt64 = 1
  private var unsubscribe: (@Sendable () -> Void)?

  init(client: KizunaSyncClient, now: @escaping @Sendable () -> Date = { Date() }) {
    self.client = client
    self.now = now
  }

  /// Subscribe the ring to the engine's event bus.
  ///
  /// Throws the engine's code when the subscription cannot be installed.
  func attach() async throws {
    let cancel = try await client.on { [weak self] event in
      self?.record(event)
    }
    store(cancel)
  }

  private func store(_ cancel: @escaping @Sendable () -> Void) {
    lock.lock()
    unsubscribe = cancel
    lock.unlock()
  }

  /// Release the event subscription. Idempotent.
  func detach() {
    lock.lock()
    let cancel = unsubscribe
    unsubscribe = nil
    lock.unlock()
    cancel?()
  }

  /// One coherent read of the local command queue.
  ///
  /// Throws the engine's code when the snapshot cannot be read.
  public func snapshot() async throws -> KizunaSyncInspectorSnapshot {
    let raw = try await client.inspect()
    return KizunaSyncInspectorSnapshot(
      queued: raw["queued"] as? [[String: Any]] ?? [],
      depth: raw["depth"] as? Int ?? 0,
      lastMutationId: raw["last_mutation_id"] as? String,
      cursor: raw["cursor"] as? String ?? "",
      clientId: raw["client_id"] as? String ?? ""
    )
  }

  /// The refusals the ring holds, oldest first. It keeps the last 50.
  public func verdicts() -> [KizunaSyncInspectorVerdict] {
    lock.lock()
    defer { lock.unlock() }
    return ring
  }

  /// Observe every change to the ring. Returns an unsubscribe function.
  public func subscribe(_ onChange: @escaping () -> Void) -> () -> Void {
    lock.lock()
    let id = nextListenerId
    nextListenerId += 1
    listeners[id] = onChange
    lock.unlock()
    return { [weak self] in
      self?.lock.lock()
      self?.listeners.removeValue(forKey: id)
      self?.lock.unlock()
    }
  }

  /// Drop the ring. The examples' "reset local" wipes devtools state too.
  public func clear() {
    lock.lock()
    ring.removeAll()
    let observers = Array(listeners.values)
    lock.unlock()
    for observer in observers {
      observer()
    }
  }

  /// The event-bus seam. A refusal or an overwrite joins the ring, and every
  /// event notifies the observers, because a snapshot read beside the ring may
  /// also have moved.
  internal func record(_ event: KizunaSyncEngineEvent) {
    let verdict: KizunaSyncInspectorVerdict?
    switch event {
    case .mutationRejected(let mutationId, let reason):
      verdict = KizunaSyncInspectorVerdict(
        mutationId: mutationId,
        kind: .rejected,
        reason: reason,
        at: now()
      )
    case .batchAborted(let offenderMutationId, let reason):
      verdict = KizunaSyncInspectorVerdict(
        mutationId: offenderMutationId,
        kind: .aborted,
        reason: reason,
        at: now()
      )
    case .columnOverwritten(let table, _, let column, _, let winnerMutationId, _):
      verdict = KizunaSyncInspectorVerdict(
        mutationId: winnerMutationId,
        kind: .overwritten,
        reason: "\(table).\(column)",
        at: now()
      )
    default:
      verdict = nil
    }
    lock.lock()
    if let verdict {
      ring.append(verdict)
      if ring.count > kizunasyncVerdictRingCap {
        ring.removeFirst(ring.count - kizunasyncVerdictRingCap)
      }
    }
    let observers = Array(listeners.values)
    lock.unlock()
    for observer in observers {
      observer()
    }
  }
}

#endif
