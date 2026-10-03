import Foundation
import KizunaSync

/// Bucketless `todos` config; server RLS, not a communal-board rule, determines
/// which rows a configured remote can expose.
public enum TodoBoard {
  public static let table = "todos"
  public static let titleMaxLength = 50

  /// Caps `title` at `titleMaxLength` characters, so the add form's draft
  /// never grows past what the server's check constraint accepts.
  public static func clampedTitle(_ title: String) -> String {
    title.count > titleMaxLength ? String(title.prefix(titleMaxLength)) : title
  }

  /// `clientId` is the device identity the server registers, so it is a uuid;
  /// passing nil mints one for this run.
  public static func clientConfig(
    clientId: String? = nil,
    databasePath: String,
    supabaseURL: String?,
    publishableKey: String?,
    accessToken: String?
  ) -> KizunaSyncClientConfig {
    var remote: KizunaSyncRemoteConfig?
    if let supabaseURL, let publishableKey, !supabaseURL.isEmpty, !publishableKey.isEmpty {
      remote = KizunaSyncRemoteConfig(
        url: supabaseURL,
        publishableKey: publishableKey,
        accessToken: accessToken
      )
    }
    return KizunaSyncClientConfig(
      clientId: clientId,
      tables: [table: KizunaSyncTableConfig()],
      databasePath: databasePath,
      remote: remote
    )
  }
}
