/**
 * Resolves every corpus cite to a PUBLIC referent.
 *
 * node:fs/node:path only: packages/protocol/ ships zero runtime deps; dev
 * tooling is devDependencies [CONV:repository-layout]. Run with Bun.
 *
 * Machine-checks the I-7 authority grammar (harness/invariants.ts
 * CITE_PATTERN). Does NOT touch cite values, the pattern, the schemas, or the
 * transcripts; it only RESOLVES the cites that already exist:
 *   - collect every distinct cite from properties/index.json (.cites),
 *     cases/manifest.json (every .cites array, incl. future_flows),
 *     transcripts/ ** /*.json (.cites), the `kizunaCites` annotations in
 *     schemas/*.json, and the `@cites` JSDoc tags in spec/*.ts;
 *   - look up its prefix in docs-authority.json;
 *   - assert the resolved target file exists;
 *   - for a sectioned prefix assert the target carries the cite's token, under
 *     the prefix's `tokenMatch` convention: `heading-token` wants a markdown
 *     HEADING whose text contains the exact token (token-bounded, so
 *     P:mutations-and-column-masked-conflict-resolution ≠ P:attachments-are-out-of-protocol-scope), `heading-slug` (CONV:) wants a heading whose
 *     slug equals the token, `sql-anchor` (SQL:) wants a `-- MARK: - <token>`
 *     line in the migration, and `registry-key` (D-) wants a key of decisions/index.json.
 * Prints a table of every cite + verdict and exits nonzero if any fail.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CITE_PATTERN, CITE_PREFIXES, CITE_TOKEN } from '../harness/invariants'
import { headingSlug } from './heading-slug'

// MARK: - Registry

type TTarget = string | Record<string, string>
type TTokenMatch = 'heading-token' | 'heading-slug' | 'sql-anchor' | 'registry-key'
type TPrefixRule = { target: TTarget; sectioned: boolean; tokenMatch?: TTokenMatch; note?: string }
type TAuthority = { repoRoot: string; prefixes: Record<string, TPrefixRule> }

const PROTOCOL_ROOT = join(import.meta.dir, '..')

const loadAuthority = (): TAuthority => {
  const raw = readFileSync(join(PROTOCOL_ROOT, 'docs-authority.json'), 'utf8')

  return JSON.parse(raw) as TAuthority
}

// MARK: - Cite collection

const isCite = (value: unknown): value is string => typeof value === 'string' && CITE_PATTERN.test(value)

/** Collects into `out` every array stored under `key`, at any depth of the parsed JSON. */
const collectArrayDeep = (node: unknown, key: string, out: Set<string>): void => {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectArrayDeep(item, key, out)
    }
    return
  }
  if (node === null || typeof node !== 'object') {
    return
  }
  const obj = node as Record<string, unknown>

  if (Array.isArray(obj[key])) {
    for (const cite of obj[key]) {
      if (isCite(cite)) {
        out.add(cite)
      }
    }
  }
  for (const value of Object.values(obj)) {
    collectArrayDeep(value, key, out)
  }
}

const walkJson = (dir: string): string[] => {
  if (!existsSync(dir)) {
    return []
  }
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const full = join(dir, entry)

      return statSync(full).isDirectory() ? walkJson(full) : full.endsWith('.json') ? [full] : []
    })
}

const collectAllCites = (root: string): Map<string, Set<string>> => {
  const sources = new Map<string, Set<string>>()
  const add = (cite: string, src: string): void => {
    if (!sources.has(cite)) {
      sources.set(cite, new Set())
    }
    sources.get(cite)!.add(src)
  }
  const addJsonFile = (abs: string, rel: string, key: 'cites' | 'kizunaCites'): void => {
    const found = new Set<string>()

    collectArrayDeep(JSON.parse(readFileSync(abs, 'utf8')), key, found)

    for (const cite of found) {
      add(cite, rel)
    }
  }

  addJsonFile(join(root, 'properties', 'index.json'), 'properties/index.json', 'cites')
  addJsonFile(join(root, 'cases', 'manifest.json'), 'cases/manifest.json', 'cites')
  addJsonFile(join(root, 'fixtures', 'domain.json'), 'fixtures/domain.json', 'cites')

  for (const abs of walkJson(join(root, 'transcripts'))) {
    addJsonFile(abs, abs.replace(`${root}/`, ''), 'cites')
  }
  for (const abs of walkJson(join(root, 'schemas'))) {
    addJsonFile(abs, abs.replace(`${root}/`, ''), 'kizunaCites')
  }

  // spec/*.ts carries the same cites as `@cites` JSDoc tags, rendered from each schema's kizunaCites.
  const specDir = join(root, 'spec')

  if (!existsSync(specDir)) {
    return sources
  }
  for (const entry of readdirSync(specDir).sort()) {
    if (!entry.endsWith('.ts')) {
      continue
    }
    const text = readFileSync(join(specDir, entry), 'utf8')

    for (const line of text.split('\n')) {
      const tag = line.match(/@cites\s+(.+)$/)

      if (tag === null) {
        continue
      }
      CITE_TOKEN.lastIndex = 0

      for (const tok of tag[1]!.match(CITE_TOKEN) ?? []) {
        add(tok, `spec/${entry}`)
      }
    }
  }

  return sources
}

// MARK: - Resolution

type TResult = { cite: string; status: 'ok' | 'fail'; detail: string }

/** Longest prefix wins so a shorter prefix cannot steal a longer one. */
const matchPrefix = (cite: string, prefixes: Record<string, TPrefixRule>): string | null => {
  let best: string | null = null

  for (const prefix of Object.keys(prefixes)) {
    if (cite.startsWith(prefix) && (best === null || prefix.length > best.length)) {
      best = prefix
    }
  }
  return best
}

const resolveTarget = (rule: TPrefixRule, cite: string): string | null => {
  if (typeof rule.target === 'string') {
    return rule.target
  }
  return rule.target[cite] ?? null
}

/** True when a heading's text carries `token` between non-alphanumeric edges. */
const headingHasToken = (markdown: string, token: string): boolean => {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const bounded = new RegExp(`(?<![0-9A-Za-z])${esc}(?![0-9A-Za-z])`)

  for (const line of markdown.split('\n')) {
    if (/^#{1,6}\s/.test(line) && bounded.test(line)) {
      return true
    }
  }
  return false
}

/** True when a heading's slug equals `token` exactly. */
const headingHasSlug = (markdown: string, token: string): boolean =>
  markdown.split('\n').some((line) => /^#{1,6}\s/.test(line) && headingSlug(line) === token)

/**
 * True when the migration carries a `-- MARK: - <token>` anchor line. The
 * comparison is against the whole trimmed line, so `tombstones-table` is never
 * satisfied by `tombstones-table-name`.
 */
const sqlHasAnchor = (sql: string, token: string): boolean =>
  sql.split('\n').some((line) => line.trim() === `-- MARK: - ${token}`)

const registryHasKey = (text: string, cite: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(text)

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && cite in parsed
  } catch {
    return false
  }
}

const hasToken = (text: string, cite: string, prefix: string, rule: TPrefixRule): boolean => {
  const token = cite.slice(prefix.length)

  switch (rule.tokenMatch ?? 'heading-token') {
    case 'heading-slug':
      return headingHasSlug(text, token)
    case 'sql-anchor':
      return sqlHasAnchor(text, token)
    case 'registry-key':
      return registryHasKey(text, cite)
    case 'heading-token':
      return headingHasToken(text, cite)
  }
}

const checkCite = (cite: string, authority: TAuthority, repoRootAbs: string): TResult => {
  const prefix = matchPrefix(cite, authority.prefixes)

  if (prefix === null) {
    return { cite, detail: 'no registry prefix maps this cite', status: 'fail' }
  }
  const rule = authority.prefixes[prefix]!
  const targetRel = resolveTarget(rule, cite)

  if (targetRel === null) {
    return { cite, detail: `prefix '${prefix}' has no per-token target for this cite`, status: 'fail' }
  }
  const targetAbs = join(repoRootAbs, ...targetRel.split('/'))

  if (!existsSync(targetAbs)) {
    return { cite, detail: `target missing: ${targetRel}`, status: 'fail' }
  }
  if (!rule.sectioned) {
    return { cite, detail: `${targetRel} (exists)`, status: 'ok' }
  }
  const convention = rule.tokenMatch ?? 'heading-token'

  if (!hasToken(readFileSync(targetAbs, 'utf8'), cite, prefix, rule)) {
    return { cite, detail: `no ${convention} for '${cite}' in ${targetRel}`, status: 'fail' }
  }
  return { cite, detail: `${targetRel} (${convention})`, status: 'ok' }
}

// MARK: - Public API

type TCiteResult = TResult

type TCiteAuthorityReport = {
  results: TCiteResult[]
  sources: Map<string, Set<string>>
}

/** Resolve every distinct corpus cite against docs-authority.json. Pure: no I/O beyond reads, no exit. */
export const checkCiteAuthority = (root: string = PROTOCOL_ROOT): TCiteAuthorityReport => {
  const authority = loadAuthority()
  const repoRootAbs = join(root, ...authority.repoRoot.split('/'))
  const sources = collectAllCites(root)
  const cites = [...sources.keys()].sort()
  const results = cites.map((cite) => checkCite(cite, authority, repoRootAbs))

  return { results, sources }
}

// MARK: - Main

const main = (): void => {
  const { results, sources } = checkCiteAuthority()
  const cites = results.map((r) => r.cite)
  const fails = results.filter((r) => r.status === 'fail')

  const width = Math.max(4, ...cites.map((c) => c.length))

  console.log(`check-cite-authority: ${cites.length} distinct cites, ${sources.size} resolved\n`)
  console.log(`${'CITE'.padEnd(width)}  RESULT  DETAIL`)
  console.log(`${'-'.repeat(width)}  ------  ------`)

  for (const r of results) {
    const mark = r.status === 'ok' ? 'PASS  ' : 'FAIL  '

    console.log(`${r.cite.padEnd(width)}  ${mark}  ${r.detail}`)
  }

  if (fails.length > 0) {
    console.log(`\n${fails.length} unresolved cite(s):`)

    for (const r of fails) {
      const srcs = [...(sources.get(r.cite) ?? [])].sort().join(', ')

      console.log(`  ${r.cite}: ${r.detail}  [cited in: ${srcs}]`)
    }
    process.exit(1)
  }

  console.log(`\nPASS: every cite resolves to a public referent.`)
}

if (import.meta.main) {
  main()
}
