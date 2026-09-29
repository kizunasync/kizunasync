import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const EXEMPT_MARKDOWN = [
  /^CHANGELOG\.md$/,
  /^CONVENTIONS\.md$/,
  /^packages\/protocol\/decisions\//,
  /^crates\/kizunasync-protocol\/WIRE_ENUM_PARITY\.md$/,
  /\/Generated\/README\.md$/,
]

const SITE_SOURCE_GLOBS = [
  'apps/website/app/*.tsx',
  'apps/website/app/**/*.tsx',
  'apps/website/app/**/route.ts',
  'apps/website/components/*.tsx',
  'apps/website/components/**/*.tsx',
  'apps/website/components/*.ts',
  'apps/website/components/**/*.ts',
  'apps/website/lib/site.ts',
  'apps/website/lib/docs-registry.ts',
  'apps/website/lib/reference/*.ts',
  'apps/website/lib/frameworks.ts',
  'apps/website/lib/journey-progress.ts',
  'apps/demo/index.html',
  'apps/demo/src/**/*.ts',
  'apps/demo/src/**/*.tsx',
]

const AI_LEXICON =
  /\b(delve|tapestry|leverag(?:e|es|ed|ing)|robust(?:ly|ness)?|seamless(?:ly)?|groundbreaking|cutting-edge|pivotal|multifaceted|foster(?:s|ed|ing)?|harness(?:es|ed|ing)? (?:the|its|your|our)|unlock(?:s|ed|ing)?|unleash(?:es|ed|ing)?|testament|furthermore|moreover|additionally|important to note|fast-paced|at the end of the day|not only\b.{0,60}\bbut|it['’]s not just|isn['’]t just|thrilled|game-changer|revolutioni[sz]e|best-in-class|to be honest)\b/i
const FILLER = /\b(just|simply|easy|easily|please|let['’]s|actually|obviously)\b/i
const LINK_HERE = /\[here\]\(/i
const STRAWMAN = /\bnot a .*, (?:but|it is)\b/i
const EM_DASH = /—/
const PUBLICATION_DISCLAIMER = /unpublished|not published|nothing is published|is published nowhere|no (?:\w+ ){1,2}(?:is|are) published|first public tag|release pending|does not resolve on|is not a public release|no supported public Kizuna release|deployment workflow is a stub|(?:packages?|binar(?:y|ies)|builds?|releases?|artifacts?) (?:are|is) not (?:yet )?available|no npm release exists|no \w+ release exists/i
const PUBLICATION_DISCLAIMER_MARKDOWN_EXEMPT: Array<[RegExp, RegExp]> = []
const MACHINE_TELLS =
  /(?<![\w-])(crucial|vital|showcas(?:e|es|ed|ing)|underscor(?:e|es|ed|ing) (?:the|that|how|its)|serves as|stands as|boasts?|deep dive|in today['’]s|it['’]s worth noting|in this guide,? we|let['’]s dive|at its core|in essence|in summary|to summarize|in conclusion|overall,|whether you['’]re|streamlin(?:e|es|ed|ing)|empower(?:s|ed|ing)?|navigate the|landscape|journey|game-changing|powerful|effortless(?:ly)?|plethora|myriad)(?![\w-])/i

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

function markdownProse(source: string): Array<[number, string]> {
  const lines: Array<[number, string]> = []
  let inFence = false

  for (const [index, line] of source.split('\n').entries()) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      continue
    }
    if (/^\s*\|/.test(line)) {
      const cells = line.split('|').map((cell) => cell.trim()).filter((cell) => cell !== '—')

      lines.push([index + 1, cells.join(' | ')])
      continue
    }
    lines.push([index + 1, line])
  }
  return lines
}

function sourceCopy(source: string): Array<[number, string]> {
  return source
    .split('\n')
    .map((line, index): [number, string] => [index + 1, line])
    .filter(([, line]) => !/^\s*(?:\/\/|\/\*\*|\*|\*\/|import\b)/.test(line))
}

function assertClean(file: string, lines: Array<[number, string]>): void {
  for (const [line, text] of lines) {
    assert.ok(!EM_DASH.test(text), `em dash in prose: ${file}:${line}`)
    assert.ok(!AI_LEXICON.test(text), `AI lexicon: ${file}:${line} -> ${text.trim()}`)
    assert.ok(!FILLER.test(text), `filler: ${file}:${line} -> ${text.trim()}`)
    assert.ok(!MACHINE_TELLS.test(text), `machine-writing tell: ${file}:${line} -> ${text.trim()}`)
    assert.ok(!LINK_HERE.test(text), `link text "here": ${file}:${line}`)
    assert.ok(!STRAWMAN.test(text), `strawman "not X, it is Y": ${file}:${line} -> ${text.trim()}`)
  }
}

function assertNoPublicationDisclaimer(file: string, lines: Array<[number, string]>, exemptions: Array<[RegExp, RegExp]> = []): void {
  const exemption = exemptions.find(([pattern]) => pattern.test(file))

  for (const [line, text] of lines) {
    if (exemption?.[1].test(text)) {
      continue
    }
    assert.ok(!PUBLICATION_DISCLAIMER.test(text), `publication disclaimer: ${file}:${line} -> ${text.trim()}`)
  }
}

describe('public copy rules', () => {
  test('every non-exempt Markdown file follows the copy rules', () => {
    for (const file of listed(['*.md'])) {
      if (EXEMPT_MARKDOWN.some((pattern) => pattern.test(file))) {
        continue
      }
      assertClean(file, markdownProse(readFileSync(join(REPO_ROOT, file), 'utf8')))
    }
  })

  test('every website and demo source string follows the copy rules', () => {
    for (const file of listed(SITE_SOURCE_GLOBS)) {
      assertClean(file, sourceCopy(readFileSync(join(REPO_ROOT, file), 'utf8')))
    }
  })

  test('no public page carries a publication disclaimer', () => {
    for (const file of listed(['*.md'])) {
      if (EXEMPT_MARKDOWN.some((pattern) => pattern.test(file))) {
        continue
      }
      assertNoPublicationDisclaimer(
        file,
        markdownProse(readFileSync(join(REPO_ROOT, file), 'utf8')),
        PUBLICATION_DISCLAIMER_MARKDOWN_EXEMPT,
      )
    }
    for (const file of listed(SITE_SOURCE_GLOBS)) {
      assertNoPublicationDisclaimer(file, sourceCopy(readFileSync(join(REPO_ROOT, file), 'utf8')))
    }
  })
})
