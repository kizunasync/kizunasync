/**
 * Supported query operators (@../../../docs/reference/query-operators.md) is the one list of every postgrest-js method.
 * Its first table holds exactly one row per method the installed postgrest-js typings declare on the client and its
 * builders. The JavaScript column agrees with the core builders' refusal lists, and each refused row carries the reason
 * its LOCAL_UNSUPPORTED message names. Every Swift and Kotlin name a row gives exists as a public function of the
 * native builders, and a dash stands only where that client has no function of that name.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { REPO_ROOT } from './doc-code-blocks'

// MARK: - Sources

const PAGE = 'docs/reference/query-operators.md'

/** postgrest-js as the app client's Supabase adapter installs it: `@kizunasync/supabase` → supabase-js → postgrest-js. */
const ADAPTER_PACKAGE = 'packages/supabase/package.json'

const REFUSALS_SOURCE = 'packages/core/src/query/refusals.ts'

const NATIVE_SOURCES = {
  swift: ['crates/kizunasync-ffi/bindings/swift/Sources/KizunaSync/KizunaSyncFrom.swift', 'crates/kizunasync-ffi/bindings/swift/Sources/KizunaSync/KizunaSyncClient.swift'],
  kotlin: ['crates/kizunasync-ffi/bindings/kotlin/src/main/kotlin/com/kizunasync/kizunasync/KizunaSyncFrom.kt', 'crates/kizunasync-ffi/bindings/kotlin/src/main/kotlin/com/kizunasync/kizunasync/KizunaSyncClient.kt'],
} as const

type TNativeLibrary = keyof typeof NATIVE_SOURCES

/** Members every JavaScript class carries or every thenable implements; they are not query methods. */
const NOT_QUERY_METHODS = new Set(['constructor', 'toJSON', 'then'])

const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8')

// MARK: - The page's tables

interface IRow {
  method: string
  javascript: string
  swift: string
  kotlin: string
  notes: string
}

/** Splits a Markdown table row on the pipes that are not escaped as `\|`. */
const cellsOf = (line: string): string[] => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim())

/** The body rows of the first table whose header starts with `firstHeader`, one cell array per row. */
function tableRows(markdown: string, firstHeader: string): string[][] {
  const lines = markdown.split('\n')
  const header = lines.findIndex((line) => line.startsWith('|') && cellsOf(line)[0] === firstHeader)

  if (header < 0) {
    return []
  }
  const rows: string[][] = []

  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) {
      break
    }
    rows.push(cellsOf(line))
  }
  return rows
}

/** The code-font name a row's first cell carries, linked or not. */
const nameOf = (cell: string): string => /`([A-Za-z]+)/.exec(cell)?.[1] ?? cell

function methodRows(markdown: string, firstHeader: string): IRow[] {
  return tableRows(markdown, firstHeader).map(([method = '', javascript = '', swift = '', kotlin = '', notes = '']) => ({ method: nameOf(method), javascript, swift, kotlin, notes }))
}

/** The native name a row's Notes give, as `Swift \`match(_:pattern:)\``, `Kotlin \`ilikeAll\``, or `Swift and Kotlin \`dryRun\``; else the method's own. */
function nativeName(row: IRow, library: TNativeLibrary): string {
  const pattern = library === 'swift' ? /Swift(?: and Kotlin)? `(\w+)/ : /Kotlin `(\w+)/

  return pattern.exec(row.notes)?.[1] ?? row.method
}

// MARK: - postgrest-js typings

interface IPostgrestTypings {
  version: string
  methods: string[]
}

function installedPostgrest(): IPostgrestTypings {
  const supabaseJs = createRequire(join(REPO_ROOT, ADAPTER_PACKAGE)).resolve('@supabase/supabase-js/package.json')
  const manifestPath = createRequire(supabaseJs).resolve('@supabase/postgrest-js/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string; exports: { '.': { import: { types: string } } } }
  const typings = readFileSync(join(dirname(manifestPath), manifest.exports['.'].import.types), 'utf8')

  return { version: manifest.version, methods: builderMethods(typings) }
}

/**
 * Method names declared on `PostgrestClient` and every `Postgrest*Builder` class. A class body runs from its
 * `declare class` line to the next line that is a lone `}`; members sit at two spaces, and a method is a member name
 * followed at once by `(` or `<`, so properties and `private`/`protected` members never match.
 */
function builderMethods(typings: string): string[] {
  const methods = new Set<string>()
  let inBuilder = false

  for (const line of typings.split('\n')) {
    if (/^declare (?:abstract )?class Postgrest(?:Client|\w*Builder)\b/.test(line)) {
      inBuilder = true
    } else if (line === '}') {
      inBuilder = false
    }
    const member = inBuilder ? /^ {2}([A-Za-z_$][\w$]*)[<(]/.exec(line)?.[1] : undefined

    if (member !== undefined && !NOT_QUERY_METHODS.has(member)) {
      methods.add(member)
    }
  }
  return [...methods].sort()
}

// MARK: - Core refusals

interface IRefusals {
  reasons: Map<string, string>
  chains: string[][]
}

/** The string elements of `export const <name> = [...] as const`. */
function quotedList(source: string, name: string): string[] {
  const body = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`).exec(source)?.[1] ?? ''

  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '')
}

/** `REFUSAL_REASONS` with each value resolved, whether a literal or a module constant, and the three chain lists. */
function coreRefusals(): IRefusals {
  const source = read(REFUSALS_SOURCE)
  const constants = new Map([...source.matchAll(/^const ([A-Z_]+) = '([^']+)'$/gm)].map((match) => [match[1] ?? '', match[2] ?? '']))
  const catalog = /const REFUSAL_REASONS = \{([\s\S]*?)\} as const/.exec(source)?.[1] ?? ''
  const reasons = new Map<string, string>()

  for (const match of catalog.matchAll(/^\s+(\w+): (?:'([^']+)'|([A-Z_]+)),$/gm)) {
    reasons.set(match[1] ?? '', match[2] ?? constants.get(match[3] ?? '') ?? '')
  }
  return { reasons, chains: ['READ_REFUSALS', 'WRITE_REFUSALS', 'WRITE_SELECT_REFUSALS'].map((name) => quotedList(source, name)) }
}

/**
 * A catalogued method is unsupported when every builder chain refuses it, or when no chain lists it because it lives
 * only on `from()` or the app client and refuses there. One listed on some chains only (`maxAffected` on reads, `csv`
 * on writes) works where the others offer it.
 */
function isRefusedEverywhere(method: string, refusals: IRefusals): boolean {
  if (!refusals.reasons.has(method)) {
    return false
  }
  const listing = refusals.chains.filter((chain) => chain.includes(method)).length

  return listing === 0 || listing === refusals.chains.length
}

// MARK: - Native sources

/** Public function names: Swift `public func`, Kotlin `fun` without `private` or `internal`. */
function nativeFunctions(library: TNativeLibrary): Set<string> {
  const pattern = library === 'swift' ? /\bpublic\s+(?:static\s+)?func\s+`?(\w+)`?/g : /^\s*(?:(?:override|suspend|inline|operator)\s+)*fun\s+(?:<[^>]*>\s*)?(\w+)\s*\(/gm
  const names = NATIVE_SOURCES[library].flatMap((path) => [...read(path).matchAll(pattern)].map((match) => match[1] ?? ''))

  return new Set(names)
}

// MARK: - Tests

describe('Supported query operators', () => {
  const page = read(PAGE)
  const rows = methodRows(page, 'Method')
  const postgrest = installedPostgrest()

  test('names the installed postgrest-js version', () => {
    expect(page).toContain(`postgrest-js ${postgrest.version}`)
  })

  test('has exactly one row per postgrest-js client and builder method', () => {
    const names = rows.map((row) => row.method)

    expect(postgrest.methods.length).toBeGreaterThan(50)
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([])
    expect([...names].sort()).toEqual(postgrest.methods)
  })

  test('the JavaScript column follows the core refusal lists, with each refusal reason in Notes', () => {
    const refusals = coreRefusals()

    expect(refusals.reasons.size).toBeGreaterThan(0)
    expect(refusals.chains.every((chain) => chain.length > 0)).toBe(true)

    for (const row of rows) {
      const refused = isRefusedEverywhere(row.method, refusals)

      expect({ method: row.method, javascript: row.javascript }).toEqual({ method: row.method, javascript: refused ? 'No' : 'Yes' })

      if (refused) {
        expect({ method: row.method, notes: row.notes }).toEqual({ method: row.method, notes: expect.stringContaining(refusals.reasons.get(row.method) ?? '') })
      }
    }
  })

  test('every Swift and Kotlin name a row gives is a public native function, and a dash marks a missing one', () => {
    const additions = methodRows(page, 'Addition')

    expect(additions.length).toBeGreaterThan(0)

    for (const library of ['swift', 'kotlin'] as const) {
      const functions = nativeFunctions(library)

      for (const row of [...rows, ...additions]) {
        const cell = row[library]

        expect({ method: row.method, library, cell }).toEqual({ method: row.method, library, cell: expect.stringMatching(/^(Yes|No|—)$/) })

        const name = nativeName(row, library)

        expect({ method: row.method, library, name, present: functions.has(name) }).toEqual({ method: row.method, library, name, present: cell !== '—' })
      }
    }
  })
})
