import Foundation

/**
 * What the builders do to rows the kernel already answered: the columns a
 * write's `select(_:)` keeps, `stripNulls()`, and `csv()`, by the rules
 * `packages/core/src/query/row-shaping.ts` applies for JavaScript. None of it
 * filters or orders; that stays in the kernel. The kernel writes every row's
 * keys in sorted order, so sorting them here gives `csv()` over every column
 * the header order JavaScript gives.
 */
enum KizunaSyncRowShaping {
  /// The column list a write's `select(_:)` names, or a refusal for an embed
  /// or a rename, which the kernel would refuse on a read.
  static func returnedColumns(_ columns: String) -> (columns: [String]?, refusal: String?) {
    let trimmed = columns.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty || trimmed == "*" {
      return (nil, nil)
    }
    let entries = trimmed.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    if let embed = entries.first(where: { $0.contains("(") }) {
      return (nil, "select(\"\(embed)\"): relational embeds are not supported locally; the local store holds each synced table without foreign-key joins, so read related rows with a second query")
    }
    if let rename = entries.first(where: { $0.contains(":") }) {
      return (nil, "select(\"\(rename)\"): renames are not supported locally")
    }
    return (entries, nil)
  }

  /// `row` cut to `columns`, in their order; a column the row lacks is null.
  static func project(_ row: [String: Any], _ columns: [String]?) -> [String: Any] {
    guard let columns else { return row }
    var projected: [String: Any] = [:]
    for column in columns {
      projected[column] = row[column] ?? NSNull()
    }
    return projected
  }

  /// A read's answer without the null-valued keys of each row it holds.
  static func stripNulls(_ answer: Any) -> Any {
    if let row = answer as? [String: Any] {
      return row.filter { !($0.value is NSNull) }
    }
    if let rows = answer as? [[String: Any]] {
      return rows.map { $0.filter { !($0.value is NSNull) } }
    }
    return answer
  }

  /// The rows as CSV text: a header line, then one line per row, separated by
  /// `\n` with no trailing line break. A read that names no column and matches
  /// no row is empty.
  static func csv(_ rows: [[String: Any]], projection: [String]?) -> String {
    let columns = projection ?? orderedKeys(rows)
    guard !columns.isEmpty else { return "" }
    let header = columns.map(field).joined(separator: ",")
    let lines = rows.map { row in columns.map { field(text(row[$0])) }.joined(separator: ",") }
    return ([header] + lines).joined(separator: "\n")
  }

  private static func orderedKeys(_ rows: [[String: Any]]) -> [String] {
    var seen: [String] = []
    for row in rows {
      for key in row.keys.sorted() where !seen.contains(key) {
        seen.append(key)
      }
    }
    return seen
  }

  /// A field quoted, with its quotes doubled, when it holds a quote, a comma, or a line break (RFC 4180).
  private static func field(_ text: String) -> String {
    guard text.contains(where: { $0 == "\"" || $0 == "," || $0 == "\r" || $0 == "\n" }) else { return text }
    return "\"\(text.replacingOccurrences(of: "\"", with: "\"\""))\""
  }

  /// A cell's text: empty for null, JSON for an array or an object, the value otherwise.
  private static func text(_ value: Any?) -> String {
    switch value {
    case nil, is NSNull:
      return ""
    case let string as String:
      return string
    case let number as NSNumber:
      if CFGetTypeID(number) == CFBooleanGetTypeID() {
        return number.boolValue ? "true" : "false"
      }
      return number.stringValue
    case let nested?:
      guard JSONSerialization.isValidJSONObject(nested),
            let data = try? JSONSerialization.data(withJSONObject: nested, options: [.sortedKeys, .withoutEscapingSlashes])
      else { return String(describing: nested) }
      return String(decoding: data, as: UTF8.self)
    }
  }
}
