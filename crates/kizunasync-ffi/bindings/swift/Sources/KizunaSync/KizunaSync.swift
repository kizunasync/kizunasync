import Foundation

/**
 * Errors raised by the Kizuna Swift app client.
 *
 * `code` is the stable catalog code an app switches on. It is the value the
 * engine reported, or the code the host itself assigns to a check it makes
 * before the call reaches the engine. The description is always
 * `"CODE: message"`.
 *
 * Six conditions the host raises on its own, with the code each carries:
 *
 * - `CONFIG_INVALID`, `config is not utf8`: the encoded configuration is not
 *   text the engine can read.
 * - `ENGINE_UNAVAILABLE`, `payload is not utf8`: the encoded call payload is
 *   not text the engine can read.
 * - `ENGINE_UNAVAILABLE`, `inspect: expected an object`,
 *   `<method>: unreadable envelope`, or `query: unreadable payload`: the
 *   bridge answered with bytes the client cannot decode, which is the same
 *   class of fault as a missing engine artifact.
 * - `LOCAL_UNSUPPORTED`, `apply requires table and pk`: a local request the
 *   client refuses, the class the kernel uses for a request it cannot answer.
 *
 * `ATTACHMENT_PORTS_MISSING` and `UNKNOWN_TABLE` are the other two codes the
 * host raises itself. Every remaining code arrives from the engine unchanged.
 */
public enum KizunaSyncError: Error, Equatable, CustomStringConvertible {
  case engine(code: String, message: String)

  /// The stable catalog code an app switches on.
  public var code: String {
    switch self {
    case .engine(let code, _):
      return code
    }
  }

  /// The failure text without the code prefix.
  public var message: String {
    switch self {
    case .engine(_, let message):
      return message
    }
  }

  public var description: String {
    "\(code): \(message)"
  }
}

/// XCTest and `NSError.localizedDescription` read `LocalizedError`, not
/// `CustomStringConvertible`; without this conformance both print Foundation's
/// generic locale text instead of the code and message.
extension KizunaSyncError: LocalizedError {
  public var errorDescription: String? { description }
}

/**
 * Catalog codes the client raises before a call reaches the engine. Every other
 * code arrives from the engine and is carried through unchanged. The conditions
 * behind these codes are listed on `KizunaSyncError`.
 */
enum KizunaSyncErrorCode {
  static let attachmentPortsMissing = "ATTACHMENT_PORTS_MISSING"
  static let unknownTable = "UNKNOWN_TABLE"
  static let configInvalid = "CONFIG_INVALID"
  static let engineUnavailable = "ENGINE_UNAVAILABLE"
  static let localUnsupported = "LOCAL_UNSUPPORTED"
}
