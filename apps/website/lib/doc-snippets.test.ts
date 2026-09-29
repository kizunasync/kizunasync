/**
 * Every code block in docs/ has to compile as a module of its own against the real packages, so a block that uses a
 * name it never imports fails here. TypeScript, TSX, JavaScript, and the `lang="ts"` script of a Vue block compile
 * inside an example app (todo-react, todo-vue, or todo-expo) with that app's compiler and node_modules. Test files
 * and config or script files compile in a separate tooling program with Bun's types, so Bun and Node globals never
 * reach app code. Swift and Kotlin blocks, which no compiler here can build, get an import-line check instead.
 *
 * Check a subset of pages with DOC_SNIPPETS_FILES, a space- or comma-separated list of repository-relative docs paths
 * or git globs: `DOC_SNIPPETS_FILES='docs/sync/*.md docs/reference/vue/**' bun test lib/doc-snippets.test.ts`.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const FIXTURES_DIR = 'apps/website/lib/doc-snippets-fixtures'
const GENERATED_DIR = '.doc-snippets'
const CHECK_TIMEOUT_MS = 300_000

/** Each test process writes below its own folder, so docs writers running the test side by side never share files. */
const RUN_DIR = `run-${process.pid}`

// MARK: - Types

type TGroup = 'web' | 'vue' | 'expo'

type TProgram = TGroup | `tooling-${TGroup}`

interface IGroupApp {
  app: string
  tsconfig: string
  module: string
}

interface IDocBlock {
  file: string

  /** Markdown line of the block's first content line (the file label). */
  line: number

  lang: string
  tab: string | null
  lines: string[]
}

interface ISnippet {
  program: TProgram
  group: TGroup
  file: string
  line: number

  /** `<docs path without docs/ and .md>`, the folder every block of one page shares so relative imports resolve. */
  page: string

  /** Path below `page`: the labelled path, or a numbered sibling of it. */
  path: string

  source: string
}

/** The program a snippet compiles in, and the example app that hosts it. */
type TTarget = Pick<ISnippet, 'program' | 'group'>

interface IFailure {
  file: string
  line: number
  text: string
}

interface ITscDiagnostic {
  path: string
  line: number
  code: string
  message: string
}

interface ICompileResult {
  failures: IFailure[]

  /** Generated paths of the blocks this run reported. */
  failedPaths: Set<string>
}

interface IImportRule {
  uses: RegExp
  requires: (match: string) => string
}

// MARK: - Groups

const GROUP_APPS: Record<TGroup, IGroupApp> = {
  web: { app: 'examples/todo-react', tsconfig: 'tsconfig.app.json', module: 'esnext' },
  vue: { app: 'examples/todo-vue', tsconfig: 'tsconfig.app.json', module: 'esnext' },
  expo: { app: 'examples/todo-expo', tsconfig: 'tsconfig.json', module: 'preserve' },
}

const TAB_GROUPS: Record<string, TGroup> = {
  React: 'web',
  Vite: 'web',
  'Vanilla / other': 'web',
  TypeScript: 'web',
  Vue: 'vue',
  'Expo/React Native': 'expo',
}

const COMPILED_LANGS = new Set(['ts', 'typescript', 'tsx', 'js', 'jsx'])
const SCRIPT_EXTENSION = /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/

// MARK: - Swift and Kotlin import rules

const SWIFT_RULES: IImportRule[] = [
  { uses: /\bKizunaSync\w*/g, requires: () => 'KizunaSync' },
  { uses: /\bSupabaseClient\b|\bsupabase\.auth\b/g, requires: () => 'Supabase' },
  { uses: /\b(?:struct|class|extension)\s+\w+\s*:[^{]*\b(?:View|App)\b/g, requires: () => 'SwiftUI' },
]

const KOTLIN_RULES: IImportRule[] = [
  { uses: /\bKizunaSync\w+/g, requires: (name) => `com.kizunasync.kizunasync.${name}` },
  { uses: /\bcreateSupabaseClient\b/g, requires: () => 'io.github.jan.supabase.createSupabaseClient' },
  { uses: /\binstall\(\s*Auth\s*\)/g, requires: () => 'io.github.jan.supabase.auth.Auth' },
  { uses: /\.auth\./g, requires: () => 'io.github.jan.supabase.auth.auth' },
]

// MARK: - Markdown blocks

function listed(patterns: string[]): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', ...patterns],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter((file) => file.length > 0 && existsSync(join(REPO_ROOT, file)))
}

/** The docs pages to check: every tracked docs/**\/*.md, or the DOC_SNIPPETS_FILES subset. */
function docsFiles(): string[] {
  const requested = (process.env.DOC_SNIPPETS_FILES ?? '').split(/[\s,]+/).filter((pattern) => pattern.length > 0)
  const patterns = requested.map((pattern) => (isAbsolute(pattern) ? relative(REPO_ROOT, pattern) : pattern))

  if (patterns.length === 0) {
    return listed(['docs/**/*.md'])
  }

  return listed(patterns).filter((file) => file.startsWith('docs/') && file.endsWith('.md'))
}

function tabLabel(meta: string): string | null {
  const quoted = /tab=(["'])(.*?)\1/.exec(meta)

  if (quoted?.[2] !== undefined) {
    return quoted[2]
  }

  return /tab=(\S+)/.exec(meta)?.[1] ?? null
}

function docBlocks(file: string, source: string): IDocBlock[] {
  const blocks: IDocBlock[] = []
  let open: IDocBlock | null = null

  for (const [index, line] of source.split('\n').entries()) {
    if (open === null) {
      const fence = /^```([A-Za-z0-9]*)(.*)$/.exec(line)

      if (fence !== null) {
        open = { file, line: index + 2, lang: (fence[1] ?? '').toLowerCase(), tab: tabLabel(fence[2] ?? ''), lines: [] }
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

function labelOf(block: IDocBlock): string | null {
  const first = block.lines[0]?.trim() ?? ''
  const match = block.lang === 'vue' ? /^<!--\s*(.*?)\s*-->$/.exec(first) : /^\/\/\s*(.*)$/.exec(first)

  return match?.[1] ?? null
}

/** A label that names a package (`// @kizunasync/core`) marks an API listing, not code from the reader's project. */
function isPackageListing(block: IDocBlock): boolean {
  return /^@[\w.-]+\/[\w.-]+/.test(labelOf(block) ?? '')
}

// MARK: - TypeScript snippets

/** The lines tsc compiles and their offset in the block: the whole block, or the `lang="ts"` script of a Vue block. */
function compiledLines(block: IDocBlock): { offset: number; lines: string[] } | null {
  if (COMPILED_LANGS.has(block.lang)) {
    return { offset: 0, lines: block.lines }
  }
  if (block.lang !== 'vue') {
    return null
  }
  const start = block.lines.findIndex((line) => /^<script\b[^>]*\blang=["']ts["'][^>]*>$/.test(line.trim()))

  if (start < 0) {
    return null
  }
  const end = block.lines.findIndex((line, index) => index > start && line.trim() === '</script>')

  return { offset: start + 1, lines: block.lines.slice(start + 1, end < 0 ? undefined : end) }
}

/** Package names the code imports, requires, or re-exports (`expo-sqlite/localStorage/install` → `expo-sqlite`). */
function importedPackages(lines: string[]): string[] {
  const source = lines.join('\n')
  const pattern = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]/g
  const specifiers = source.matchAll(pattern)

  return [...specifiers]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '')
    .filter((specifier) => specifier.length > 0 && !specifier.startsWith('.'))
    .map((specifier) => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/'))
}

function groupOf(block: IDocBlock, packages: string[]): TGroup {
  const byTab = block.tab === null ? undefined : TAB_GROUPS[block.tab]

  if (byTab !== undefined) {
    return byTab
  }
  if (packages.some((name) => ['react-native', 'expo', '@kizunasync/expo'].includes(name) || name.startsWith('expo-'))) {
    return 'expo'
  }
  if (packages.some((name) => name === 'vue' || name === '@kizunasync/vue')) {
    return 'vue'
  }
  if (block.file === 'docs/getting-started/expo.md' || block.file.startsWith('docs/reference/expo/')) {
    return 'expo'
  }
  if (block.file === 'docs/getting-started/vue.md' || block.file.startsWith('docs/reference/vue/')) {
    return 'vue'
  }

  return 'web'
}

/** Test files and config or script files run in Node or Bun, never in the app, so they get the tooling program. */
function isTooling(path: string, packages: string[]): boolean {
  return packages.includes('bun:test') || /\.config\.[^/]+$/.test(path) || path.startsWith('scripts/')
}

function extensionOf(lang: string): string {
  if (lang === 'tsx' || lang === 'js' || lang === 'jsx') {
    return `.${lang}`
  }

  return '.ts'
}

/**
 * The labelled path, or `snippet-<line>` when the label names none. A path that is not a script (`src/App.vue`) gets
 * a `.script.ts` suffix, so `import App from './App.vue'` still reaches the Vue shim instead of the script module.
 */
function labelledPath(block: IDocBlock): string {
  const token = (labelOf(block) ?? '').split(/\s+/)[0]?.replace(/[.,;:]+$/, '') ?? ''
  const namesFile = token.includes('/') || /\.[A-Za-z0-9]{1,5}$/.test(token)
  const normalized = posix.normalize(token)
  const isInsidePage = !normalized.startsWith('..') && !posix.isAbsolute(normalized)
  const path = namesFile && isInsidePage ? normalized : `snippet-${block.line}`

  if (SCRIPT_EXTENSION.test(path)) {
    return path
  }

  return posix.extname(path) === '' ? `${path}${extensionOf(block.lang)}` : `${path}.script${extensionOf(block.lang)}`
}

/** A second block with the same path on the same page becomes `name.2.ts` beside the first. */
function claimPath(path: string, taken: Set<string>): string {
  const extension = posix.extname(path)
  const stem = path.slice(0, path.length - extension.length)
  let candidate = path

  for (let copy = 2; taken.has(candidate); copy += 1) {
    candidate = `${stem}.${copy}${extension}`
  }
  taken.add(candidate)

  return candidate
}

function typeScriptSnippets(blocks: IDocBlock[]): ISnippet[] {
  const takenByPage = new Map<string, Set<string>>()

  return blocks.flatMap((block): ISnippet[] => {
    const compiled = compiledLines(block)

    if (compiled === null || isPackageListing(block)) {
      return []
    }
    const packages = importedPackages(compiled.lines)
    const group = groupOf(block, packages)
    const labelled = labelledPath(block)
    const program: TProgram = isTooling(labelled, packages) ? `tooling-${group}` : group
    const page = block.file.replace(/^docs\//, '').replace(/\.md$/, '')
    const taken = takenByPage.get(`${program}/${page}`) ?? new Set<string>()

    takenByPage.set(`${program}/${page}`, taken)

    return [{
      program,
      group,
      file: block.file,
      line: block.line + compiled.offset,
      page,
      path: claimPath(labelled, taken),
      source: `${compiled.lines.join('\n')}\n`,
    }]
  })
}

// MARK: - Type-checking inside an example app

function runRoot(group: TGroup): string {
  return join(REPO_ROOT, GROUP_APPS[group].app, GENERATED_DIR, RUN_DIR)
}

function programRoot({ program, group }: TTarget): string {
  return join(runRoot(group), program)
}

/** Removes this run's folders; the shared `.doc-snippets` folder goes only once no other run still uses it. */
function removeRunFolders(groups: TGroup[]): void {
  for (const group of groups) {
    rmSync(runRoot(group), { recursive: true, force: true })

    try {
      rmdirSync(dirname(runRoot(group)))
    } catch {
      // Another run still holds its folder there, or nothing was generated for this group.
    }
  }
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function fixtureFiles(group: TGroup): Array<[string, string]> {
  const root = join(REPO_ROOT, FIXTURES_DIR, group)

  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name)

      return [relative(root, path).split('\\').join('/'), readFileSync(path, 'utf8')]
    })
}

/**
 * Extends the example's own tsconfig. The unused-name checks are off because an excerpt often declares a value the
 * page uses further down, and `moduleDetection: 'force'` keeps a block without imports a module of its own.
 */
function tsconfigFor(target: TTarget): string {
  const { program, group } = target
  const app = GROUP_APPS[group]
  const tsconfig = {
    extends: relative(programRoot(target), join(REPO_ROOT, app.app, app.tsconfig)),
    compilerOptions: {
      composite: false,
      incremental: false,
      tsBuildInfoFile: null,
      noEmit: true,
      strict: true,
      noUnusedLocals: false,
      noUnusedParameters: false,
      allowJs: true,
      checkJs: true,
      module: app.module,
      moduleResolution: 'bundler',
      moduleDetection: 'force',
      ...(program === group ? {} : { types: ['bun'] }),
    },
    include: ['**/*'],
  }

  return `${JSON.stringify(tsconfig, null, 2)}\n`
}

/**
 * Writes the page folders with the canonical fixtures a page does not write itself, and each declaration fixture once
 * at the program root, where it applies to every page. Returns generated path → fixture path.
 */
function writeProgram(target: TTarget, snippets: ISnippet[]): Map<string, string> {
  const { group } = target
  const root = programRoot(target)
  const written = new Set(snippets.map((snippet) => posix.join(snippet.page, snippet.path)))
  const fixtures = fixtureFiles(group)
  const fixtureCopies = new Map<string, string>()

  rmSync(root, { recursive: true, force: true })

  for (const snippet of snippets) {
    writeFile(join(root, snippet.page, snippet.path), snippet.source)
  }
  for (const [path, content] of fixtures.filter(([path]) => path.endsWith('.d.ts'))) {
    writeFile(join(root, path), content)
    fixtureCopies.set(path, posix.join(FIXTURES_DIR, group, path))
  }
  for (const page of new Set(snippets.map((snippet) => snippet.page))) {
    for (const [path, content] of fixtures.filter(([path]) => !path.endsWith('.d.ts'))) {
      const target = posix.join(page, path)

      if (!written.has(target)) {
        writeFile(join(root, target), content)
        fixtureCopies.set(target, posix.join(FIXTURES_DIR, group, path))
      }
    }
  }
  writeFile(join(root, 'tsconfig.json'), tsconfigFor(target))

  return fixtureCopies
}

async function runTsc(root: string, group: TGroup, flags: string[]): Promise<{ exitCode: number; output: string }> {
  const tsc = join(REPO_ROOT, GROUP_APPS[group].app, 'node_modules/.bin/tsc')
  const command = [tsc, '-p', 'tsconfig.json', '--pretty', 'false', ...flags]
  const child = Bun.spawn(command, { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  return { exitCode, output: `${stdout}${stderr}` }
}

/** tsc `--pretty false` lines: `path(line,col): error TSxxxx: message`, with indented continuation lines. */
function tscDiagnostics(output: string): ITscDiagnostic[] {
  const diagnostics: ITscDiagnostic[] = []

  for (const line of output.split('\n')) {
    const located = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(line)
    const general = /^error (TS\d+): (.*)$/.exec(line)
    const previous = diagnostics.at(-1)

    if (located !== null) {
      const [, path = '', lineNumber, code = '', message = ''] = located

      diagnostics.push({ path, line: Number(lineNumber), code, message })
    } else if (general !== null) {
      diagnostics.push({ path: '', line: 0, code: general[1] ?? '', message: general[2] ?? '' })
    } else if (line.trim().length > 0 && previous !== undefined) {
      previous.message = `${previous.message} ${line.trim()}`
    }
  }

  return diagnostics
}

/** One tsc run over the program, with each diagnostic mapped back to its docs file and line. */
async function compileProgram(target: TTarget, snippets: ISnippet[], flags: string[]): Promise<ICompileResult> {
  const { program, group } = target
  const root = programRoot(target)
  const fixtureCopies = writeProgram(target, snippets)
  const byPath = new Map(snippets.map((snippet) => [posix.join(snippet.page, snippet.path), snippet]))
  const { exitCode, output } = await runTsc(root, group, flags)
  const diagnostics = tscDiagnostics(output.replaceAll(`${root}/`, ''))
  const failedPaths = new Set(diagnostics.map(({ path }) => path).filter((path) => byPath.has(path)))

  if (exitCode !== 0 && diagnostics.length === 0) {
    const text = `[${program}] tsc exited ${exitCode}: ${output.trim()}`

    return { failures: [{ file: GROUP_APPS[group].app, line: 0, text }], failedPaths }
  }

  const failures = diagnostics.map(({ path, line, code, message }): IFailure => {
    const snippet = byPath.get(path)

    if (snippet !== undefined) {
      const docLine = snippet.line + line - 1

      return { file: snippet.file, line: docLine, text: `${snippet.file}:${docLine} [${program}] ${code}: ${message}` }
    }
    const outside = path === '' ? GROUP_APPS[group].app : relative(REPO_ROOT, resolve(root, path))
    const where = fixtureCopies.get(path) ?? outside

    return { file: where, line, text: `${where}:${line} [${program}] ${code}: ${message}` }
  })

  return { failures, failedPaths }
}

/**
 * tsc reports no type errors at all while any file in the program has a syntax error, so one broken block would hide
 * every other block's missing import. A parse-only pass (`--noCheck`) reports the broken blocks, and the checked pass
 * leaves them out; a canonical fixture then fills a path whose only block did not parse.
 */
async function typeFailures(target: TTarget, snippets: ISnippet[]): Promise<IFailure[]> {
  const parsed = await compileProgram(target, snippets, ['--noCheck'])
  const parseable = snippets.filter((snippet) => !parsed.failedPaths.has(posix.join(snippet.page, snippet.path)))
  const checked = await compileProgram(target, parseable, [])

  return [...parsed.failures, ...checked.failures]
}

// MARK: - Swift and Kotlin checks

function isImported(imports: Set<string>, name: string): boolean {
  const dot = name.lastIndexOf('.')

  return imports.has(name) || (dot > 0 && imports.has(`${name.slice(0, dot)}.*`))
}

function missingImports(block: IDocBlock): IFailure[] {
  const language = block.lang === 'swift' ? 'swift' : block.lang === 'kotlin' || block.lang === 'kt' ? 'kotlin' : null

  if (language === null || isPackageListing(block)) {
    return []
  }
  const rules = language === 'swift' ? SWIFT_RULES : KOTLIN_RULES
  const imports = new Set(block.lines.flatMap((line) => /^\s*import\s+(\w+(?:\.\w+)*(?:\.\*)?)/.exec(line)?.[1] ?? []))
  const firstUse = new Map<string, number>()

  for (const [index, line] of block.lines.entries()) {
    if (/^\s*(?:import|package)\s/.test(line)) {
      continue
    }
    // Strings and comments are stripped first, so a mention in a log message or a note does not count as a use.
    const code = line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '')

    for (const rule of rules) {
      for (const match of code.matchAll(rule.uses)) {
        const name = rule.requires(match[0])

        if (!firstUse.has(name)) {
          firstUse.set(name, block.line + index)
        }
      }
    }
  }

  return [...firstUse]
    .filter(([name]) => !isImported(imports, name))
    .map(([name, line]) => ({ file: block.file, line, text: `${block.file}:${line} [${language}] missing import ${name}` }))
}

// MARK: - The check

async function checkBlocks(blocks: IDocBlock[]): Promise<string[]> {
  const snippets = typeScriptSnippets(blocks)
  const targets = [...new Map(snippets.map(({ program, group }): [TProgram, TTarget] => [program, { program, group }])).values()]

  try {
    const compiled = await Promise.all(
      targets.map((target) => typeFailures(target, snippets.filter((snippet) => snippet.program === target.program))),
    )
    const failures = [...blocks.flatMap(missingImports), ...compiled.flat()]
    const unique = new Map(failures.map((failure) => [failure.text, failure]))

    return [...unique.values()]
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.text.localeCompare(b.text))
      .map((failure) => failure.text)
  } finally {
    removeRunFolders([...new Set(targets.map((target) => target.group))])
  }
}

afterAll(() => {
  removeRunFolders(Object.keys(GROUP_APPS) as TGroup[])
})

// MARK: - Samples

const SAMPLE_FILE = 'docs/sample.md'

const SAMPLE = [
  '# Sample',
  '',
  '```ts',
  '// src/add-todo.ts',
  "import { kizunasync } from './kizunasync'",
  '',
  "await kizunasync.from('todos').insert({ title: 'works on a plane', done: false })",
  '```',
  '',
  '```ts',
  '// src/add-todo.ts (excerpt)',
  "await kizunasync.from('todos').insert({ title: 'works on a plane', done: false })",
  '```',
  '',
  '```ts',
  '// @kizunasync/core',
  'export declare function listedOnly(): TUndeclared',
  '```',
  '',
  ':::tabs',
  '```tsx tab=React',
  '// src/components/todo-count.tsx',
  "import { useQuery } from '@kizunasync/react'",
  '',
  'export function TodoCount() {',
  "  const { data } = useQuery((kizunasync) => kizunasync.from('todos').select())",
  '',
  '  return <p>{data.length}</p>',
  '}',
  '```',
  '```tsx tab=React',
  '// src/components/todo-title.tsx',
  "import { useQuery } from '@kizunasync/react'",
  '',
  'export function TodoTitle() {',
  "  const { data } = useQuery((kizunasync) => kizunasync.from('todos').select())",
  '',
  '  return <TodoRow title={String(data[0]?.title)} />',
  '}',
  '```',
  '```vue tab=Vue',
  '<!-- src/components/TodoCount.vue -->',
  '<script setup lang="ts">',
  "import { useQuery } from '@kizunasync/vue'",
  '',
  "const { data } = useQuery((kizunasync) => kizunasync.from('todos').select())",
  '</script>',
  '',
  '<template>',
  '  <p>{{ data.length }}</p>',
  '</template>',
  '```',
  '```vue tab=Vue',
  '<!-- src/components/TodoTitle.vue -->',
  '<script setup lang="ts">',
  "const title = ref('works on a plane')",
  '</script>',
  '',
  '<template>',
  '  <p>{{ title }}</p>',
  '</template>',
  '```',
  ':::',
  '',
  '```ts',
  '// src/main.ts',
  "import { createApp } from 'vue'",
  "import TodoCount from './components/TodoCount.vue'",
  '',
  "createApp(TodoCount).mount('#app')",
  '```',
  '',
  '```tsx',
  '// src/components/todo-count-native.tsx',
  "import { Text } from 'react-native'",
  "import { useQuery } from '@kizunasync/react'",
  '',
  'export function TodoCountNative() {',
  "  const { data } = useQuery((kizunasync) => kizunasync.from('todos').select())",
  '',
  '  return <Text>{data.length}</Text>',
  '}',
  '```',
  '',
  '```ts',
  '// vite.config.ts',
  "import { defineConfig } from 'vite'",
  '',
  'export default defineConfig({ root: __dirname })',
  '```',
  '',
  '```ts',
  '// src/add-todo.test.ts',
  "import { test } from 'bun:test'",
  '',
  "test('adds a todo', () => {",
  '  expect(1).toBe(1)',
  '})',
  '```',
  '',
  '```ts',
  '// src/runtime.ts',
  'export const runtime = Bun.version',
  '```',
  '',
  '```swift',
  '// TodoApp/TodoListView.swift',
  'import KizunaSync',
  'import SwiftUI',
  '',
  'struct TodoListView: View {',
  '    let client: KizunaSyncClient',
  '',
  '    var body: some View {',
  '        Text("works on a plane")',
  '    }',
  '}',
  '```',
  '',
  '```swift',
  '// TodoApp/TodoRow.swift',
  'import SwiftUI',
  '',
  'struct TodoRow: View {',
  '    let client: KizunaSyncClient',
  '',
  '    var body: some View {',
  '        Text("works on a plane")',
  '    }',
  '}',
  '```',
  '',
  '```kotlin',
  '// app/src/main/kotlin/com/example/todo/TodoSync.kt',
  'package com.example.todo',
  '',
  'import com.kizunasync.kizunasync.KizunaSyncClient',
  '',
  'fun describe(client: KizunaSyncClient): String = client.toString()',
  '```',
  '',
  '```kotlin',
  '// app/src/main/kotlin/com/example/todo/TodoScreen.kt',
  'package com.example.todo',
  '',
  'fun describe(client: KizunaSyncClient): String = client.toString()',
  '```',
  '',
  '```sql',
  '-- Supabase SQL editor or psql',
  'select undeclared from nowhere;',
  '```',
].join('\n')

describe('doc snippet checks', () => {
  test('Swift and Kotlin blocks import every module and name they use', () => {
    const tableConfig = 'val config = KizunaSyncTableConfig(bucket = KizunaSyncBucket.ByOwner("user_id"))'
    const cases: Array<[string, string[], string[]]> = [
      ['swift', ['import Foundation', 'let supabase = SupabaseClient(supabaseURL: url, supabaseKey: key)'], ['11 [swift] missing import Supabase']],
      ['swift', ['import Supabase', 'let session = try await supabase.auth.session'], []],
      ['swift', ['@main', 'struct TodoApp: App {', '}'], ['11 [swift] missing import SwiftUI']],
      ['swift', ['// KizunaSyncClient is built in TodoSync.swift', 'print("KizunaSyncClient")'], []],
      [
        'kotlin',
        ['import io.github.jan.supabase.auth.Auth', 'val supabase = createSupabaseClient(url, key) {', '    install(Auth)', '}'],
        ['11 [kotlin] missing import io.github.jan.supabase.createSupabaseClient'],
      ],
      [
        'kotlin',
        ['import io.github.jan.supabase.createSupabaseClient', 'val supabase = createSupabaseClient(url, key) {', '    install(Auth)', '}'],
        ['12 [kotlin] missing import io.github.jan.supabase.auth.Auth'],
      ],
      ['kotlin', ['val session = supabase.auth.currentSessionOrNull()'], ['10 [kotlin] missing import io.github.jan.supabase.auth.auth']],
      ['kotlin', ['import com.kizunasync.kizunasync.*', tableConfig], []],
      [
        'kotlin',
        ['import com.kizunasync.kizunasync.KizunaSyncClient', tableConfig],
        ['11 [kotlin] missing import com.kizunasync.kizunasync.KizunaSyncTableConfig', '11 [kotlin] missing import com.kizunasync.kizunasync.KizunaSyncBucket'],
      ],
      ['kotlin', ['// @kizunasync/core', 'val client: KizunaSyncClient'], []],
    ]

    for (const [lang, lines, expected] of cases) {
      const failures = missingImports({ file: 'docs/native.md', line: 10, lang, tab: null, lines }).map((failure) => failure.text)

      expect(failures).toEqual(expected.map((failure) => `docs/native.md:${failure}`))
    }
  })

  test('blocks go to the program their tab, imports, label, or page names', () => {
    const programOf = (file: string, lang: string, tab: string | null, lines: string[]): TProgram | undefined =>
      typeScriptSnippets([{ file, line: 1, lang, tab, lines }])[0]?.program

    expect(programOf('docs/sync/sample.md', 'ts', 'Vue', ['// src/a.ts', "import { View } from 'react-native'"])).toBe('vue')
    expect(programOf('docs/sync/sample.md', 'ts', null, ['// src/a.ts', "import { View } from 'react-native'"])).toBe('expo')
    expect(programOf('docs/sync/sample.md', 'ts', null, ['// src/a.ts', "import 'expo-sqlite/localStorage/install'"])).toBe('expo')
    expect(programOf('docs/sync/sample.md', 'ts', null, ['// src/a.ts', "import { useQuery } from '@kizunasync/vue'"])).toBe('vue')
    expect(programOf('docs/reference/vue/sample.md', 'ts', null, ['// src/a.ts', "import { openExpoDriver } from '@kizunasync/expo'"])).toBe('expo')
    expect(programOf('docs/reference/vue/sample.md', 'ts', null, ['// src/a.ts', 'export const a = 1'])).toBe('vue')
    expect(programOf('docs/sync/sample.md', 'ts', null, ['// src/a.ts', 'export const a = 1'])).toBe('web')
    expect(programOf('docs/sync/sample.md', 'js', null, ['// metro.config.js', "const { getDefaultConfig } = require('expo/metro-config')"])).toBe('tooling-expo')
    expect(programOf('docs/sync/sample.md', 'ts', null, ['// scripts/seed.ts', 'export const a = 1'])).toBe('tooling-web')
    expect(programOf('docs/getting-started/vue.md', 'ts', null, ['// src/a.test.ts', "import { test } from 'bun:test'"])).toBe('tooling-vue')
  })

  test('a sample page fails exactly the blocks that miss an import, in every language family and program', async () => {
    const failures = await checkBlocks(docBlocks(SAMPLE_FILE, SAMPLE))

    expect(failures).toEqual([
      "docs/sample.md:12 [web] TS2304: Cannot find name 'kizunasync'.",
      "docs/sample.md:38 [web] TS2304: Cannot find name 'TodoRow'.",
      "docs/sample.md:56 [vue] TS2304: Cannot find name 'ref'.",
      "docs/sample.md:97 [tooling-web] TS2304: Cannot find name 'expect'.",
      "docs/sample.md:103 [web] TS2868: Cannot find name 'Bun'. Do you need to install type definitions for Bun? Try `npm i --save-dev @types/bun` and then add 'bun' to the types field in your tsconfig.",
      'docs/sample.md:125 [swift] missing import KizunaSync',
      'docs/sample.md:146 [kotlin] missing import com.kizunasync.kizunasync.KizunaSyncClient',
    ])
    expect((Object.keys(GROUP_APPS) as TGroup[]).filter((group) => existsSync(runRoot(group)))).toEqual([])
  }, CHECK_TIMEOUT_MS)
})

describe('docs code blocks', () => {
  test('every docs/**/*.md code block imports what it uses and type-checks against the real packages', async () => {
    const files = docsFiles()
    const blocks = files.flatMap((file) => docBlocks(file, readFileSync(join(REPO_ROOT, file), 'utf8')))
    const failures = await checkBlocks(blocks)

    expect(files.length, 'DOC_SNIPPETS_FILES matched no docs/**/*.md file').toBeGreaterThan(0)
    expect(failures.length, `${failures.length} docs code block failures:\n${failures.join('\n')}`).toBe(0)
  }, CHECK_TIMEOUT_MS)
})
