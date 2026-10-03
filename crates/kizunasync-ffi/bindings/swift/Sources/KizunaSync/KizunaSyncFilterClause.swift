import Foundation

/**
 * One PostgREST clause, `column.operator.value`, as the filter node the kernel
 * reads: the grammar `filter(_:operator:value:)` takes, the same one
 * `packages/core/src/query/filter-clauses.ts` decodes for JavaScript `.or()`
 * strings. The operator is one of ten, optionally behind a `not.` prefix, and
 * the value decodes as null, a boolean, a number that prints back as itself,
 * or text, with double quotes protecting commas and parentheses.
 */
enum KizunaSyncFilterClause {
  /// The operators a clause may name.
  static let operators: Set<String> = ["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in"]

  /// Why a clause has no node, named in the LOCAL_UNSUPPORTED the read throws.
  struct Refusal: Error {
    let reason: String
  }

  static func node(column: String, operator op: String, value: String) throws -> [String: Any] {
    let isNegated = op.hasPrefix("not.")
    let name = isNegated ? String(op.dropFirst("not.".count)) : op
    guard operators.contains(name) else {
      throw Refusal(reason: "unsupported filter operator \"\(name)\"")
    }
    try checkBalanced(value)
    let node = try leaf(column: column, operator: name, value: value)
    return isNegated ? ["kind": "not", "filter": node] : node
  }

  private static func leaf(column: String, operator name: String, value: String) throws -> [String: Any] {
    switch name {
    case "in":
      return ["kind": "in", "column": column, "values": try inList(value)]
    case "is":
      let operand = scalar(value)
      guard operand is NSNull || operand is Bool else {
        throw Refusal(reason: "is() value must be null|true|false")
      }
      return ["kind": "is", "column": column, "value": operand]
    case "like", "ilike":
      return ["kind": name, "column": column, "pattern": pattern(value)]
    default:
      return ["kind": name, "column": column, "value": scalar(value)]
    }
  }

  /// A value that is one double-quoted string, its `\"` and `\\` escapes
  /// decoded, or nil when it does not open with a quote and end at the quote
  /// that closes it.
  static func unquote(_ value: String) -> String? {
    let chars = Array(value)
    guard chars.first == "\"" else { return nil }
    var decoded = ""
    var index = 1
    while index < chars.count {
      let ch = chars[index]
      let next: Character? = index + 1 < chars.count ? chars[index + 1] : nil
      if ch == "\\", let next, next == "\"" || next == "\\" {
        decoded.append(next)
        index += 2
        continue
      }
      if ch == "\"" {
        return index == chars.count - 1 ? decoded : nil
      }
      decoded.append(ch)
      index += 1
    }
    return nil
  }

  static func scalar(_ raw: String) -> Any {
    let trimmed = raw.trimmingCharacters(in: .whitespaces)
    if let quoted = unquote(trimmed) {
      return quoted
    }
    switch trimmed {
    case "null":
      return NSNull()
    case "true":
      return true
    case "false":
      return false
    default:
      return roundTripNumber(trimmed) ?? trimmed
    }
  }

  /// A `like` pattern: a `*` inside double quotes is a literal asterisk, so it
  /// travels escaped; a backslash pair the pattern already holds stays.
  static func pattern(_ raw: String) -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespaces)
    guard let quoted = unquote(trimmed) else { return trimmed }
    let chars = Array(quoted)
    var escaped = ""
    var index = 0
    while index < chars.count {
      if chars[index] == "\\", index + 1 < chars.count {
        escaped.append(chars[index])
        escaped.append(chars[index + 1])
        index += 2
        continue
      }
      escaped.append(chars[index] == "*" ? "\\*" : String(chars[index]))
      index += 1
    }
    return escaped
  }

  static func inList(_ raw: String) throws -> [Any] {
    var body = raw.trimmingCharacters(in: .whitespaces)
    if body.hasPrefix("("), body.hasSuffix(")") {
      body = String(body.dropFirst().dropLast())
    }
    return try topLevelParts(body)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
      .map(scalar)
  }

  /// The parts of `input` between commas outside double quotes and parentheses.
  static func topLevelParts(_ input: String) throws -> [String] {
    var parts: [String] = []
    var current = ""
    var depth = 0
    var inQuote = false
    let chars = Array(input)
    var index = 0
    while index < chars.count {
      let ch = chars[index]
      current.append(ch)
      if inQuote {
        if ch == "\\", index + 1 < chars.count {
          current.append(chars[index + 1])
          index += 2
          continue
        }
        inQuote = ch != "\""
      } else if ch == "\"" {
        inQuote = true
      } else if ch == "(" {
        depth += 1
      } else if ch == ")" {
        guard depth > 0 else { throw Refusal(reason: "unbalanced parenthesis in filter clause \"\(input)\"") }
        depth -= 1
      } else if ch == ",", depth == 0 {
        parts.append(String(current.dropLast()))
        current = ""
      }
      index += 1
    }
    if inQuote {
      throw Refusal(reason: "unclosed double quote in filter clause \"\(input)\"")
    }
    if depth > 0 {
      throw Refusal(reason: "unbalanced parenthesis in filter clause \"\(input)\"")
    }
    parts.append(current)
    return parts
  }

  private static func checkBalanced(_ value: String) throws {
    _ = try topLevelParts(value)
  }

  /// A bare numeric token as a number when JavaScript prints that number back
  /// as the same token, so `007`, `1.50` and an integer past double precision
  /// stay text on every client.
  static func roundTripNumber(_ token: String) -> NSNumber? {
    guard token.range(of: #"^-?\d+(\.\d+)?$"#, options: .regularExpression) != nil,
          token != "-0",
          let value = Double(token),
          abs(value) < 1e21
    else { return nil }

    let unsigned = token.hasPrefix("-") ? String(token.dropFirst()) : token
    if unsigned.count > 1, unsigned.hasPrefix("0"), !unsigned.hasPrefix("0.") {
      return nil
    }
    // JavaScript prints a fraction with no trailing zero, and in exponent form below 1e-6.
    if token.contains("."), token.hasSuffix("0") || abs(value) < 1e-6 {
      return nil
    }
    guard shortestDigits(value) == trimmedDigits(token) else { return nil }

    return value.rounded() == value && abs(value) <= 9_007_199_254_740_992
      ? NSNumber(value: Int64(value))
      : NSNumber(value: value)
  }

  /// The significant digits of a decimal, trailing zeros dropped: JavaScript
  /// pads an integer with zeros past the digits it keeps.
  private static func trimmedDigits(_ decimal: String) -> String {
    significantDigits(decimal).replacingOccurrences(of: "0+$", with: "", options: .regularExpression)
  }

  /// The token's significant digits, without sign, point, or leading zeros.
  private static func significantDigits(_ token: String) -> String {
    let digits = token.filter(\.isNumber)
    return String(digits.drop { $0 == "0" })
  }

  /// The fewest significant digits that parse back to `value`, the ones
  /// JavaScript prints.
  private static func shortestDigits(_ value: Double) -> String {
    for precision in 1...17 {
      let candidate = String(format: "%.\(precision - 1)e", value)
      guard Double(candidate) == value else { continue }
      return trimmedDigits(String(candidate.split(separator: "e")[0]))
    }
    return ""
  }
}
