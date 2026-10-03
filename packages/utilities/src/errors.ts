/** The message of a caught value: `Error.message`, or `String(reason)` for anything else. */
export function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
