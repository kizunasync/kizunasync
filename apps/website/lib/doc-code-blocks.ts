/**
 * The fenced code blocks of the docs/ pages and the packages they import, read the same way by the tests that walk
 * every page: doc-snippets.test.ts compiles the blocks, and install-coverage.test.ts checks each import against the
 * library's Installing page.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const IMPORT_SPECIFIER = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]/g

const EXPO_PACKAGES = new Set(['react-native', 'expo', '@kizunasync/expo'])
const VUE_PACKAGES = new Set(['vue', '@kizunasync/vue'])

export interface IDocBlock {
  file: string

  /** Markdown line of the block's first content line (the file label). */
  line: number

  lang: string
  tab: string | null
  lines: string[]
}

/** Tracked and untracked, non-ignored repository files that match the git pathspecs and still exist on disk. */
export function listRepositoryFiles(patterns: string[]): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', ...patterns],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter((file) => file.length > 0 && existsSync(join(REPO_ROOT, file)))
}

function parseTabLabel(meta: string): string | null {
  const quoted = /tab=(["'])(.*?)\1/.exec(meta)

  if (quoted?.[2] !== undefined) {
    return quoted[2]
  }

  return /tab=(\S+)/.exec(meta)?.[1] ?? null
}

export function parseDocBlocks(file: string, source: string): IDocBlock[] {
  const blocks: IDocBlock[] = []
  let open: IDocBlock | null = null

  for (const [index, line] of source.split('\n').entries()) {
    if (open === null) {
      const fence = /^```([A-Za-z0-9]*)(.*)$/.exec(line)

      if (fence !== null) {
        open = { file, line: index + 2, lang: (fence[1] ?? '').toLowerCase(), tab: parseTabLabel(fence[2] ?? ''), lines: [] }
      }
      continue
    }
    if (/^```\s*$/.test(line)) {
      blocks.push(open)
      open = null
      continue
    }
    open.lines.push(line)
  }

  return blocks
}

/** The first-line file label: `// src/kizunasync.ts`, or `<!-- src/App.vue -->` in a Vue block. */
export function parseBlockLabel(block: IDocBlock): string | null {
  const first = block.lines[0]?.trim() ?? ''
  const match = block.lang === 'vue' ? /^<!--\s*(.*?)\s*-->$/.exec(first) : /^\/\/\s*(.*)$/.exec(first)

  return match?.[1] ?? null
}

/** A label that names a package (`// @kizunasync/core`) marks an API listing, not code from the reader's project. */
export function isPackageListing(block: IDocBlock): boolean {
  return /^@[\w.-]+\/[\w.-]+/.test(parseBlockLabel(block) ?? '')
}

/** Every specifier the code imports, requires, or re-exports, relative ones included. */
export function readImportSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_SPECIFIER)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '')
    .filter((specifier) => specifier.length > 0)
}

/** The package a bare specifier installs from: `expo-sqlite/localStorage/install` → `expo-sqlite`. */
export function resolvePackageName(specifier: string): string {
  return specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
}

/** Expo or Vue when the imported packages name that framework, Expo first; null for code that could run anywhere. */
export function detectImportedFramework(packages: string[]): 'expo' | 'vue' | null {
  if (packages.some((name) => EXPO_PACKAGES.has(name) || name.startsWith('expo-'))) {
    return 'expo'
  }
  if (packages.some((name) => VUE_PACKAGES.has(name))) {
    return 'vue'
  }

  return null
}
