/**
 * Each client library's Installing page names every package its docs import, so a reader who installs what that page
 * lists can run every code block of the library's reference, guide, and tabs on the shared Sync, Attachments, and
 * Operations pages. JavaScript specifiers count by package name, Swift by `import` module, and Kotlin by the Gradle
 * artifact an import prefix comes from. What the app template already brings (React and Vite, Vue, an Expo Router
 * app, the Apple SDK, an Android Compose app) is exempt. A name counts when the Installing page shows it in code: a
 * fenced block or an inline code span.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectImportedFramework, isPackageListing, listRepositoryFiles, parseDocBlocks, readImportSpecifiers, REPO_ROOT, resolvePackageName, type IDocBlock } from './doc-code-blocks'

// MARK: - Types

type TLibrary = 'javascript' | 'react' | 'vue' | 'expo' | 'swift' | 'kotlin'

interface IImport {
  library: TLibrary

  /** Package, Swift module, or Gradle artifact the Installing page has to show. */
  name: string

  file: string
  line: number
}

// MARK: - Libraries

const LIBRARIES: TLibrary[] = ['javascript', 'react', 'vue', 'expo', 'swift', 'kotlin']

/** Pages whose blocks belong to one library, as a docs path or a folder prefix ending in `/`. */
const LIBRARY_PAGES: Record<TLibrary, string[]> = {
  javascript: ['docs/reference/javascript/', 'docs/getting-started/vite.md', 'docs/getting-started/vanilla-js.md', 'docs/getting-started/quickstart.md'],
  react: ['docs/reference/react/', 'docs/getting-started/react.md'],
  vue: ['docs/reference/vue/', 'docs/getting-started/vue.md'],
  expo: ['docs/reference/expo/', 'docs/getting-started/expo.md'],
  swift: ['docs/reference/swift/'],
  kotlin: ['docs/reference/kotlin/'],
}

/** Pages shared by every library: each block counts for the library its tab, language, or imports name. */
const SHARED_PAGES = ['docs/getting-started/native-clients.md', 'docs/sync/', 'docs/attachments/', 'docs/operations/']

const TAB_LIBRARIES: Record<string, TLibrary> = {
  React: 'react',
  Vite: 'javascript',
  'Vanilla / other': 'javascript',
  TypeScript: 'javascript',
  Vue: 'vue',
  'Expo/React Native': 'expo',
  Swift: 'swift',
  Kotlin: 'kotlin',
}

const JAVASCRIPT_LANGS = new Set(['ts', 'typescript', 'tsx', 'js', 'jsx', 'vue'])

/**
 * What the app each library assumes already declares. Kotlin entries are import prefixes: an Android Compose app gets
 * `kotlinx-coroutines-android` through `androidx.activity:activity-compose`, whose Compose runtime and lifecycle
 * dependencies expose it as an API dependency.
 */
const TEMPLATE_PROVIDED: Record<TLibrary, string[]> = {
  javascript: ['react', 'react-dom', 'vite'],
  react: ['react', 'react-dom', 'vite'],
  vue: ['vue'],
  expo: ['react', 'react-native', 'expo', 'expo-router'],
  swift: ['Foundation', 'SwiftUI', 'Combine', 'Network', 'UIKit', 'XCTest'],
  kotlin: ['android.', 'androidx.', 'java.', 'kotlin.', 'kotlinx.coroutines.', 'org.json.'],
}

/** Kotlin import prefix → the Gradle coordinate or artifact the Installing page declares for it; first match wins. */
const KOTLIN_ARTIFACTS: Array<[string, string]> = [
  ['com.kizunasync.kizunasync.', 'com.kizunasync:kizunasync'],
  ['io.github.jan.supabase.auth.', 'auth-kt'],
  ['io.github.jan.supabase.realtime.', 'realtime-kt'],
  ['io.github.jan.supabase.', 'io.github.jan-tennert.supabase:bom'],
]

// MARK: - Installing pages

/** Fenced block bodies and inline code spans: the places an Installing page names what to install. */
function codeText(markdown: string): string {
  const fenced = parseDocBlocks('', markdown).map((block) => block.lines.join('\n'))
  const prose = markdown.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '')
  const spans = [...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? '')

  return [...fenced, ...spans].join('\n')
}

function isShownInCode(code: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  return new RegExp(`(?<![\\w@/.-])${escaped}(?![\\w/-])`).test(code)
}

// MARK: - Imports

/** The package a JavaScript specifier installs, or null for a relative path or a `node:` or `bun:` built-in. */
function packageOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('bun:')) {
    return null
  }

  return resolvePackageName(specifier)
}

/** The specifiers a line imports, the Swift module, or the Kotlin import path. */
function lineImports(lang: string, line: string): string[] {
  if (JAVASCRIPT_LANGS.has(lang)) {
    return readImportSpecifiers(line)
  }
  if (lang === 'swift') {
    return /^\s*(?:@\w+\s+)*import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?(\w+)/.exec(line)?.slice(1, 2) ?? []
  }
  if (lang === 'kotlin' || lang === 'kt') {
    return /^\s*import\s+([\w.]+)/.exec(line)?.slice(1, 2) ?? []
  }

  return []
}

/** What each line of a block imports, before any mapping: `[name, index in block]`. */
function importedNames(block: IDocBlock): Array<[string, number]> {
  if (isPackageListing(block)) {
    return []
  }

  return block.lines.flatMap((line, index) => lineImports(block.lang, line).map((name): [string, number] => [name, index]))
}

/** The name the Installing page has to show for an import, or null when the import needs no install. */
function requiredName(library: TLibrary, imported: string): string | null {
  const provided = TEMPLATE_PROVIDED[library]

  if (library === 'kotlin') {
    if (provided.some((prefix) => imported.startsWith(prefix))) {
      return null
    }

    return KOTLIN_ARTIFACTS.find(([prefix]) => imported.startsWith(prefix))?.[1] ?? imported
  }
  const name = library === 'swift' ? imported : packageOf(imported)

  return name === null || provided.includes(name) ? null : name
}

function ownerOf(file: string, pages: string[]): boolean {
  return pages.some((page) => (page.endsWith('/') ? file.startsWith(page) : file === page))
}

/**
 * A block's library: its tab label, then its language for Swift and Kotlin, then an Expo or Vue import (as in
 * doc-snippets.test.ts), then the library that owns the page. An untabbed JavaScript block on a shared page counts
 * for JavaScript.
 */
function libraryOf(block: IDocBlock, packages: string[]): TLibrary | null {
  const byTab = block.tab === null ? undefined : TAB_LIBRARIES[block.tab]
  const framework = detectImportedFramework(packages)
  const owner = LIBRARIES.find((library) => ownerOf(block.file, LIBRARY_PAGES[library]))

  if (byTab !== undefined) {
    return byTab
  }
  if (block.lang === 'swift' || block.lang === 'kotlin' || block.lang === 'kt') {
    return block.lang === 'swift' ? 'swift' : 'kotlin'
  }
  if (framework !== null) {
    return framework
  }
  if (owner !== undefined) {
    return owner
  }

  return ownerOf(block.file, SHARED_PAGES) ? 'javascript' : null
}

/** Every import a library's pages make that needs an install, in page and line order. */
function librariesImports(blocks: IDocBlock[]): IImport[] {
  return blocks.flatMap((block): IImport[] => {
    const names = importedNames(block)
    const packages = names.flatMap(([name]) => packageOf(name) ?? [])
    const library = libraryOf(block, packages)

    if (library === null) {
      return []
    }

    return names.flatMap(([imported, index]) => {
      const name = requiredName(library, imported)

      return name === null ? [] : [{ library, name, file: block.file, line: block.line + index }]
    })
  })
}

/** One failure per library and name its Installing page leaves out, at the first page and line that imports it. */
function missingInstalls(imports: IImport[], installingCode: (library: TLibrary) => string): string[] {
  const first = new Map<string, IImport>()

  for (const entry of imports) {
    const key = `${entry.library} ${entry.name}`

    if (!first.has(key)) {
      first.set(key, entry)
    }
  }

  return [...first.values()]
    .filter((entry) => !isShownInCode(installingCode(entry.library), entry.name))
    .map(({ library, name, file, line }) =>
      `${library}: ${name} is imported at ${file}:${line} but docs/reference/${library}/installing.md does not list it`,
    )
}

// MARK: - Samples

describe('install coverage checks', () => {
  test('imports resolve to the package, module, or artifact an Installing page lists', () => {
    const namesIn = (lang: string, lines: string[]): string[] =>
      importedNames({ file: 'docs/sync/sample.md', line: 10, lang, tab: null, lines }).map(([name]) => name)
    const javascript = [
      "import 'react-native-url-polyfill/auto'",
      "import { openExpoFileStore } from '@kizunasync/expo/file-store'",
      "import { kizunasync } from './kizunasync'",
      "import { test } from 'bun:test'",
      "const { getDefaultConfig } = require('expo/metro-config')",
    ]
    const kotlin = [
      'import io.github.jan.supabase.auth.auth',
      'import io.github.jan.supabase.realtime.channel',
      'import io.github.jan.supabase.createSupabaseClient',
      'import com.kizunasync.kizunasync.*',
      'import kotlinx.coroutines.launch',
      'import androidx.compose.ui.Modifier',
      'import io.ktor.client.HttpClient',
    ]

    expect(namesIn('ts', javascript).map(packageOf)).toEqual(['react-native-url-polyfill', '@kizunasync/expo', null, null, 'expo'])
    expect(namesIn('swift', ['import Foundation', '@testable import KizunaSync', 'import struct Supabase.Session'])).toEqual(['Foundation', 'KizunaSync', 'Supabase'])
    expect(namesIn('ts', ['// @kizunasync/core', "import type { TRow } from '@kizunasync/protocol'"])).toEqual([])
    expect(namesIn('kotlin', kotlin).map((name) => requiredName('kotlin', name))).toEqual([
      'auth-kt',
      'realtime-kt',
      'io.github.jan-tennert.supabase:bom',
      'com.kizunasync:kizunasync',
      null,
      null,
      'io.ktor.client.HttpClient',
    ])
    expect(requiredName('javascript', '@supabase/supabase-js')).toBe('@supabase/supabase-js')
    expect(requiredName('react', 'react-dom/client')).toBeNull()
    expect(requiredName('vue', 'vue')).toBeNull()
    expect(requiredName('expo', 'expo-router')).toBeNull()
    expect(requiredName('swift', 'XCTest')).toBeNull()
  })

  test('blocks count for the library their tab, language, imports, or page names', () => {
    const libraryAt = (file: string, lang: string, tab: string | null, packages: string[]): TLibrary | null =>
      libraryOf({ file, line: 1, lang, tab, lines: [] }, packages)

    expect(libraryAt('docs/sync/sample.md', 'tsx', 'React', ['@kizunasync/react'])).toBe('react')
    expect(libraryAt('docs/sync/sample.md', 'ts', 'TypeScript', ['@kizunasync/core'])).toBe('javascript')
    expect(libraryAt('docs/sync/sample.md', 'swift', null, [])).toBe('swift')
    expect(libraryAt('docs/getting-started/native-clients.md', 'kotlin', 'Kotlin', [])).toBe('kotlin')
    expect(libraryAt('docs/operations/sample.md', 'ts', null, ['@kizunasync/expo'])).toBe('expo')
    expect(libraryAt('docs/reference/javascript/build-integration.md', 'js', null, ['expo'])).toBe('expo')
    expect(libraryAt('docs/reference/vue/sample.md', 'ts', null, ['@kizunasync/core'])).toBe('vue')
    expect(libraryAt('docs/getting-started/vite.md', 'tsx', null, ['react', '@kizunasync/react'])).toBe('javascript')
    expect(libraryAt('docs/sync/sample.md', 'ts', null, ['@kizunasync/core'])).toBe('javascript')
    expect(libraryAt('docs/cli/cli.md', 'ts', null, ['@kizunasync/core'])).toBeNull()
  })

  test('a name counts only where the Installing page shows it in code', () => {
    const page = [
      'Point [Supabase](https://supabase.com) at the app and add `@kizunasync/react` for hooks.',
      '',
      '```bash',
      'npx expo install react-native-url-polyfill',
      '```',
    ].join('\n')
    const imports: IImport[] = [
      { library: 'swift', name: 'Supabase', file: 'docs/a.md', line: 3 },
      { library: 'swift', name: 'Supabase', file: 'docs/b.md', line: 9 },
      { library: 'react', name: '@kizunasync/react', file: 'docs/a.md', line: 4 },
      { library: 'expo', name: 'react-native-url-polyfill', file: 'docs/a.md', line: 5 },
      { library: 'expo', name: 'react-native', file: 'docs/a.md', line: 6 },
    ]

    expect(missingInstalls(imports, () => codeText(page))).toEqual([
      'swift: Supabase is imported at docs/a.md:3 but docs/reference/swift/installing.md does not list it',
      'expo: react-native is imported at docs/a.md:6 but docs/reference/expo/installing.md does not list it',
    ])
  })
})

// MARK: - The check

describe('install coverage', () => {
  test('every Installing page lists each package its library docs import', () => {
    const files = listRepositoryFiles(['docs/**/*.md'])
    const blocks = files.flatMap((file) => parseDocBlocks(file, readFileSync(join(REPO_ROOT, file), 'utf8')))
    const imports = librariesImports(blocks)
    const installingCode = (library: TLibrary): string =>
      codeText(readFileSync(join(REPO_ROOT, `docs/reference/${library}/installing.md`), 'utf8'))
    const failures = missingInstalls(imports, installingCode)

    expect(LIBRARIES.filter((library) => !imports.some((entry) => entry.library === library))).toEqual([])
    expect(failures.length, `${failures.length} packages missing from an Installing page:\n${failures.join('\n')}`).toBe(0)
  })
})
