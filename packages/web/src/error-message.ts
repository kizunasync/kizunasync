// MARK: - Caught value to text

/**
 * Both halves of the driver turn a caught `unknown` into the string that travels
 * over `postMessage`, which cannot carry an `Error`. One owner so the page and
 * the worker cannot drift on what a non-`Error` throw looks like.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
