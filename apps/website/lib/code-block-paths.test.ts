/**
 * Every fenced code block in a labeled language names, on its first line,
 * the file (or package) where the reader's project keeps that code. This
 * scans the public docs and READMEs for a block that skipped that label.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const LABELED_LANGUAGES = new Set(['ts', 'typescript', 'tsx', 'js', 'jsx', 'vue', 'swift', 'kotlin', 'kt', 'sql'])

interface IBlockFailure {
  line: number
  firstLine: string
}

function listed(patterns: string[]): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', ...patterns],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter((file) => file.length > 0 && !file.includes('.test.') && existsSync(join(REPO_ROOT, file)))
}

/** A path token with a slash or a file extension, the `kizunasync` package, or "SQL editor". */
function namesLocation(content: string): boolean {
  if (content.includes('SQL editor') || /^kizunasync(?:\/|$)/.test(content)) {
    return true
  }

  const tokens = content.split(/\s+/).map((token) => token.replace(/[.,;:()]+$/, ''))

  return tokens.some((token) => token.includes('/') || /\.[A-Za-z0-9]{1,5}$/.test(token))
}

function labelContent(lang: string, line: string): string | null {
  if (lang === 'vue') {
    return /^<!--\s*(.*?)\s*-->$/.exec(line)?.[1] ?? null
  }
  if (lang === 'sql') {
    return /^--\s*(.*)$/.exec(line)?.[1] ?? null
  }

  return /^\/\/\s*(.*)$/.exec(line)?.[1] ?? null
}

/** Fenced blocks (including ones inside :::tabs) in a labeled language whose first line names no location. */
function findUnlabeledBlocks(source: string): IBlockFailure[] {
  const failures: IBlockFailure[] = []
  let inFence = false
  let fenceLang = ''
  let fenceLine = 0
  let firstContentLine: string | null = null

  for (const [index, line] of source.split('\n').entries()) {
    const opening = !inFence ? /^```([A-Za-z0-9]*)/.exec(line) : null

    if (opening) {
      inFence = true
      fenceLang = opening[1]!.toLowerCase()
      fenceLine = index + 1
      firstContentLine = null
      continue
    }
    if (inFence && /^```\s*$/.test(line)) {
      if (LABELED_LANGUAGES.has(fenceLang)) {
        const content = firstContentLine === null ? null : labelContent(fenceLang, firstContentLine.trim())

        if (content === null || !namesLocation(content)) {
          failures.push({ line: fenceLine + 1, firstLine: firstContentLine ?? '' })
        }
      }
      inFence = false
      continue
    }
    if (inFence && firstContentLine === null) {
      firstContentLine = line
    }
  }

  return failures
}

describe('findUnlabeledBlocks', () => {
  test('flags a block missing its path label but not a labeled one', () => {
    const sample = [
      '```ts',
      "// src/kizunasync.ts",
      "import { createKizunaSync } from 'kizunasync'",
      '```',
      '',
      '```ts',
      'const client = createKizunaSync()',
      '```',
    ].join('\n')

    expect(findUnlabeledBlocks(sample)).toEqual([{ line: 7, firstLine: 'const client = createKizunaSync()' }])
  })
})

describe('code block path labels', () => {
  test('every tracked docs/**/*.md, README.md, and packages/*/README.md fenced block names its location', () => {
    const files = [...listed(['docs/**/*.md']), ...listed(['README.md']), ...listed(['packages/*/README.md'])]
    const failures: string[] = []

    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')

      for (const failure of findUnlabeledBlocks(source)) {
        failures.push(`${file}:${failure.line} -> ${failure.firstLine.trim()}`)
      }
    }

    expect(failures).toEqual([])
  })
})
