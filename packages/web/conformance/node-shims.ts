// MARK: - Browser stand-ins for the node builtins the corpus loader imports

/**
 * The conformance page reads the corpus through `import.meta.glob`, but importing
 * `@kizunasync/core/conformance` still pulls the protocol harness's filesystem loader
 * (`corpus-path.ts` and `client-executor.ts` import `node:fs`, `node:path` and
 * `node:url`), which no browser can resolve. `vite.config.ts` aliases those three
 * specifiers here.
 *
 * `join` and `dirname` are real because `corpus-path.ts` calls them at module
 * scope. Everything that would touch a filesystem throws; it does not answer
 * something plausible. A page that ever reached the node loader fails. It does
 * not replay an empty corpus (@../../../CONVENTIONS.md).
 */
const NO_FILESYSTEM = 'the conformance page has no filesystem: read the corpus through import.meta.glob'

export function join(...parts: string[]): string {
  const joined = parts.filter((part) => part !== '').join('/')

  return joined.replace(/\/{2,}/g, '/')
}

export function dirname(path: string): string {
  const cut = path.lastIndexOf('/')

  return cut <= 0 ? (cut === 0 ? '/' : '.') : path.slice(0, cut)
}

/** False everywhere, so `resolveCorpusRoot`'s walk terminates and then throws. */
export function existsSync(): boolean {
  return false
}

export function readFileSync(): never {
  throw new Error(NO_FILESYSTEM)
}

export function readdirSync(): never {
  throw new Error(NO_FILESYSTEM)
}

export function statSync(): never {
  throw new Error(NO_FILESYSTEM)
}

export function fileURLToPath(url: string | URL): string {
  return String(url).replace(/^file:\/\//, '')
}
