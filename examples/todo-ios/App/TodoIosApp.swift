import SwiftUI
import TodoIosCore
import KizunaSync

@main
struct TodoIosApp: App {
  @StateObject private var store = TodoStore()

  var body: some Scene {
    WindowGroup {
      TabView {
        BoardView(store: store)
          .tabItem { Label("Board", systemImage: "checklist") }
        CacheView(store: store)
          .tabItem { Label("Cache", systemImage: "internaldrive") }
        SettingsView(store: store)
          .tabItem { Label("Settings", systemImage: "gear") }
      }
      .task { await store.boot() }
    }
  }
}

@MainActor
final class TodoStore: ObservableObject {
  @Published var titles: [String] = []
  @Published var depth: Int = 0
  @Published var draft: String = "" {
    didSet {
      let clamped = TodoBoard.clampedTitle(draft)

      if clamped != draft {
        draft = clamped
      }
    }
  }
  @Published var error: String?
  @Published var needsReset = false
  @Published var rejections: [KizunaSyncRejection] = []
  @Published var overwrites: [KizunaSyncOverwrite] = []
  /// Off stops the automatic sync loop; on starts it again, which syncs once right away.
  @Published var liveSync = true {
    didSet {
      if liveSync {
        scheduler?.start()
      } else {
        scheduler?.stop()
      }
    }
  }
  @Published var supabaseURL = ProcessInfo.processInfo.environment["SUPABASE_URL"] ?? ""
  @Published var publishableKey =
    ProcessInfo.processInfo.environment["SUPABASE_PUBLISHABLE_KEY"]
    ?? ProcessInfo.processInfo.environment["SUPABASE_ANON_KEY"]
    ?? ""
  @Published var accessToken = ProcessInfo.processInfo.environment["SUPABASE_ACCESS_TOKEN"] ?? ""

  private var client: KizunaSyncClient?
  private var scheduler: KizunaSyncScheduler?
  private var unsubscribeHealth: (() -> Void)?
  private var databasePath: String {
    let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("kizunasync-todos.sqlite").path
  }

  /// The device identity the server's `_clients` registry keys on. It is a uuid
  /// and it outlives a launch, so retention sees one device rather than one per
  /// run.
  private var deviceId: String {
    let key = "kizunasync.clientId"
    if let existing = UserDefaults.standard.string(forKey: key) {
      return existing
    }
    let minted = UUID().uuidString.lowercased()
    UserDefaults.standard.set(minted, forKey: key)
    return minted
  }

  /// Disposes whatever client Reconnect is replacing before opening the new
  /// one: both would otherwise hold the same SQLite file at databasePath open
  /// at once.
  func boot() async {
    scheduler?.stop()
    unsubscribeHealth?()
    unsubscribeHealth = nil
    await client?.dispose()
    client = nil
    do {
      let next = KizunaSyncClient()
      try await next.create(
        TodoBoard.clientConfig(
          clientId: deviceId,
          databasePath: databasePath,
          supabaseURL: supabaseURL.isEmpty ? nil : supabaseURL,
          publishableKey: publishableKey.isEmpty ? nil : publishableKey,
          accessToken: accessToken.isEmpty ? nil : accessToken
        )
      )
      client = next
      startScheduler(next)
      try await refresh()
    } catch {
      self.error = String(describing: error)
    }
  }

  func add() async {
    let title = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { return }
    draft = ""
    do {
      try await client?.apply(
        table: TodoBoard.table,
        pk: UUID().uuidString,
        op: .insert,
        columns: ["title": title, "user_id": "local-dev", "done": false],
        mutationId: UUID().uuidString
      )
      try await refresh()
    } catch {
      self.error = String(describing: error)
    }
  }

  func refresh() async throws {
    guard let client else { return }
    depth = try await client.outboxDepth()
    let raw = try await client.query(table: TodoBoard.table, plan: ["cardinality": "many"])
    let rows = raw as? [[String: Any]] ?? []
    titles = rows.compactMap { row in
      if let title = row["title"] as? String { return title }
      if let columns = row["columns"] as? [String: Any] { return columns["title"] as? String }
      return nil
    }
    rejections = try await client.rejections()
    overwrites = try await client.overwrites()
    needsReset = try await client.checkpoint().softBlocked
  }

  /// The way out of a soft block: drop the local database and rehydrate from the
  /// server on the next pull. The sandbox paths the engine answers with are the
  /// attachment bytes the app still has to delete; this shell declares no
  /// attachment column, so the list is empty.
  func resetLocal() async {
    guard let client else { return }
    do {
      _ = try await client.reset()
      needsReset = false
      try await refresh()
      try await client.sync()
      try await refresh()
    } catch {
      self.error = String(describing: error)
    }
  }

  func dismissOverwrite(_ entry: KizunaSyncOverwrite) async {
    do {
      _ = try await client?.dismissOverwrite(entry.id)
      try await refresh()
    } catch {
      self.error = String(describing: error)
    }
  }

  private func startScheduler(_ client: KizunaSyncClient) {
    let hasRemote = !supabaseURL.isEmpty && !publishableKey.isEmpty
    let next = KizunaSyncScheduler(
      client: client,
      monitorPath: true,
      refreshSession: { [weak self] in
        guard let self else { return false }
        if hasRemote && self.accessToken.isEmpty {
          return false
        }
        if !self.accessToken.isEmpty {
          do {
            try await client.setAccessToken(self.accessToken)
          } catch {
            self.error = String(describing: error)
            return false
          }
        }
        return true
      },
      sync: { [weak self] in
        try await client.sync()
        try await self?.refresh()
      },
      onError: { [weak self] error in
        self?.error = String(describing: error)
      },
      needsReset: { (try? await client.checkpoint().softBlocked) ?? false }
    )
    scheduler = next
    unsubscribeHealth = next.onHealth { [weak self] health in
      Task { @MainActor in
        if let lastError = health.lastError {
          self?.error = lastError.message
        }
        self?.needsReset = health.needsReset
      }
    }
    if liveSync {
      next.start()
    }
  }
}

struct BoardView: View {
  @ObservedObject var store: TodoStore

  var body: some View {
    NavigationStack {
      List(store.titles, id: \.self) { Text($0) }
        .navigationTitle("Board")
        .safeAreaInset(edge: .bottom) {
          HStack {
            TextField("New todo", text: $store.draft)
            Button("Add") { Task { await store.add() } }
          }
          .padding()
        }
    }
  }
}

struct CacheView: View {
  @ObservedObject var store: TodoStore

  var body: some View {
    List {
      LabeledContent("Outbox", value: "\(store.depth)")
      if let error = store.error {
        Text(error).foregroundStyle(.red)
      }
      if store.needsReset {
        Section("Sync blocked") {
          Text("The server refused this client, so sync is blocked until reset() runs.")
          Button("Reset local database") { Task { await store.resetLocal() } }
        }
      }
      Section("Rejections") {
        if store.rejections.isEmpty {
          Text("None")
        }
        ForEach(store.rejections, id: \.mutationId) { rejection in
          LabeledContent(rejection.table, value: rejection.reason)
        }
      }
      Section("Overwrites") {
        if store.overwrites.isEmpty {
          Text("None")
        }
        ForEach(store.overwrites, id: \.id) { entry in
          LabeledContent("\(entry.table).\(entry.column)", value: entry.conflictMode)
            .swipeActions {
              Button("Dismiss") { Task { await store.dismissOverwrite(entry) } }
            }
        }
      }
    }
    .navigationTitle("Cache")
  }
}

struct SettingsView: View {
  @ObservedObject var store: TodoStore

  var body: some View {
    Form {
      Toggle("Live sync", isOn: $store.liveSync)
      TextField("Supabase URL", text: $store.supabaseURL)
        .textInputAutocapitalization(.never)
      SecureField("Publishable key", text: $store.publishableKey)
      SecureField("Session JWT", text: $store.accessToken)
      Button("Reconnect") { Task { await store.boot() } }
    }
    .navigationTitle("Settings")
  }
}
