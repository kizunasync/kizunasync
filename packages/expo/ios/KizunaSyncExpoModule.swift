import ExpoModulesCore
import Foundation
import KizunaSyncFfi

private struct EngineClosed: Error, LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

private final class EngineObserver: EventObserver, @unchecked Sendable {
  private let deliver: @Sendable (FfiEngineEvent) -> Void
  init(_ deliver: @escaping @Sendable (FfiEngineEvent) -> Void) { self.deliver = deliver }
  func onEvent(event: FfiEngineEvent) { deliver(event) }
}

/// The module only hosts the shared Rust engine; it never opens a second SQL connection.
@ExpoModule("KizunaSyncExpo")
public final class KizunaSyncExpoModule: Module, @unchecked Sendable {
  @Event("engineEvent") var onEngineEvent: (String) -> Void

  private struct Session {
    let engine: KizunaSyncEngine
    let observer: EngineObserver
    let subscription: UInt64
    func close() {
      try? engine.unsubscribe(subscriptionId: subscription)
      try? engine.shutdown()
    }
  }
  private let lock = NSLock()
  private var sessions: [String: Session] = [:]
  private var destroyed = false

  @JS
  func newEngineId() -> String { UUID().uuidString }

  @JS
  func databasePath(_ name: String) throws -> String {
    if name == ":memory:" { return name }
    guard !name.isEmpty, (name as NSString).lastPathComponent == name, name != ".", name != "..",
      let directory = appContext?.config.documentDirectory?.appendingPathComponent("SQLite") else {
      throw EngineClosed(message: "Invalid database name or unavailable documents directory")
    }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory.appendingPathComponent(name).standardized.path
  }

  @JS(.concurrent)
  func createEngine(_ id: String, _ configJson: String) async throws {
    let engine = KizunaSyncEngine()
    var session: Session?
    do {
      try engine.create(configJson: configJson)
      let raw = try engine.call(method: "store_kind", paramsJson: "{}")
      let envelope = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
      guard (envelope?["value"] as? [String: Any])?["engine"] as? String == "turso" else {
        throw EngineClosed(message: "Rebuild the Kizuna native engine with Turso; this binary predates the migration")
      }
      let observer = EngineObserver { [weak self] event in self?.emit(id, event) }
      let created = Session(engine: engine, observer: observer, subscription: try engine.subscribe(observer: observer))
      session = created
      try insert(id, created)
    } catch {
      if let session { session.close() } else { try? engine.shutdown() }
      throw error
    }
  }

  private func insert(_ id: String, _ session: Session) throws {
    lock.lock()
    defer { lock.unlock() }
    guard !destroyed, sessions[id] == nil else { throw EngineClosed(message: "Expo module closed or engine id already exists") }
    sessions[id] = session
  }

  private func engine(_ id: String) throws -> KizunaSyncEngine {
    lock.lock()
    defer { lock.unlock() }
    guard let session = sessions[id] else { throw EngineClosed(message: "Engine is closed") }
    return session.engine
  }

  @JS
  func call(_ id: String, _ method: String, _ paramsJson: String) throws -> String {
    try engine(id).call(method: method, paramsJson: paramsJson)
  }

  @JS(.concurrent)
  func callAsync(_ id: String, _ method: String, _ paramsJson: String) async throws -> String {
    try await engine(id).callAsync(method: method, paramsJson: paramsJson)
  }

  @JS(.concurrent)
  func closeEngine(_ id: String) async {
    removeSession(id)?.close()
  }

  private func removeSession(_ id: String) -> Session? {
    lock.lock()
    let session = sessions.removeValue(forKey: id)
    lock.unlock()
    return session
  }

  public override func willDestroy() {
    lock.lock()
    destroyed = true
    let closing = Array(sessions.values)
    sessions.removeAll()
    lock.unlock()
    closing.forEach { $0.close() }
    super.willDestroy()
  }

  private func emit(_ id: String, _ event: FfiEngineEvent) {
    let tag: String
    var inner: [String: Any] = [:]
    switch event {
    case .localChanged: tag = "LocalChanged"
    case .checkpointExpired: tag = "CheckpointExpired"
    case let .mutationRejected(mutationId, reason):
      tag = "MutationRejected"; inner = ["mutationId": mutationId, "reason": reason]
    case let .queueDepth(depth):
      tag = "QueueDepth"; inner = ["depth": depth]
    case let .resetRequired(reason):
      tag = "ResetRequired"; inner = reason.map { ["reason": $0] } ?? [:]
    case let .batchAborted(offenderMutationId, reason):
      tag = "BatchAborted"; inner = ["offenderMutationId": offenderMutationId, "reason": reason]
    case let .deadLetter(mutationId, reason):
      tag = "DeadLetter"; inner = ["mutationId": mutationId, "reason": reason]
    case let .columnOverwritten(table, pk, column, loserValueJson, winnerMutationId, conflictMode):
      tag = "ColumnOverwritten"
      inner = ["table": table, "pk": pk, "column": column, "loserValueJson": loserValueJson,
        "winnerMutationId": winnerMutationId, "conflictMode": conflictMode]
    }
    guard let data = try? JSONSerialization.data(withJSONObject: ["id": id, "event": ["tag": tag, "inner": inner]]),
      let payload = String(data: data, encoding: .utf8) else { return }
    onEngineEvent(payload)
  }
}
