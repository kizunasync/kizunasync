import Foundation
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// A subscription the scheduler holds and releases. `cancel()` is idempotent.
public protocol KizunaSyncRealtimeSubscription: AnyObject {
  /// Stop delivering. Calling it twice is a no-op.
  func cancel()
}

/**
 * The realtime doorbell, implemented by the app.
 *
 * Supabase Realtime is a WebSocket, which is outside the Rust engine, so these
 * bindings take a port instead of a dependency: the app owns the channel and
 * rings the doorbell, and the scheduler turns that into one sync. The topic of
 * a table is `kizunasync:<table>`. The READMEs carry a supabase-swift adapter the app
 * copies.
 */
public protocol KizunaSyncRealtimeWakeup: AnyObject {
  /// Subscribe to `topics` and call `onWake` on every message. The handle stops
  /// the subscription.
  func subscribe(
    topics: [String],
    onWake: @escaping @Sendable () -> Void
  ) -> KizunaSyncRealtimeSubscription
}

/**
 * The return-to-foreground source the scheduler wakes on.
 * `KizunaSyncNotificationForegroundSource` backs it with the platform's own
 * did-become-active notification; a test injects its own so the seam is
 * observable without a running application.
 */
public protocol KizunaSyncForegroundSource: AnyObject {
  /// Begin reporting. `onForeground` is called on every return to the front.
  func start(onForeground: @escaping @Sendable () -> Void)
  /// Stop reporting. Idempotent.
  func stop()
}

/**
 * The platform's did-become-active notification behind the scheduler's
 * foreground wake: `UIApplication` where UIKit is available, `NSApplication`
 * otherwise. This is what makes a backgrounded app sync on the way back in
 * rather than on its next poll.
 */
public final class KizunaSyncNotificationForegroundSource: KizunaSyncForegroundSource, @unchecked Sendable {
  private let center: NotificationCenter
  private let name: Notification.Name?
  private let lock = NSLock()
  private var token: NSObjectProtocol?

  /// Observe the running application's activations.
  public init(center: NotificationCenter = .default) {
    self.center = center
    self.name = Self.didBecomeActiveName()
  }

  /// Register for the platform notification and report every activation.
  public func start(onForeground: @escaping @Sendable () -> Void) {
    guard let name else { return }
    stop()
    let registered = center.addObserver(forName: name, object: nil, queue: nil) { _ in
      onForeground()
    }
    lock.lock()
    token = registered
    lock.unlock()
  }

  /// Drop the registration, if any. Idempotent.
  public func stop() {
    lock.lock()
    let registered = token
    token = nil
    lock.unlock()
    guard let registered else { return }
    center.removeObserver(registered)
  }

  /**
   * The notification a return to the front posts, or nil on a platform that has
   * neither application class. A nil name observes nothing rather than guessing
   * a name, so the scheduler keeps polling and the app can still call
   * `notifyForeground()` itself.
   */
  private static func didBecomeActiveName() -> Notification.Name? {
#if canImport(UIKit)
    return UIApplication.didBecomeActiveNotification
#elseif canImport(AppKit)
    return NSApplication.didBecomeActiveNotification
#else
    return nil
#endif
  }
}
