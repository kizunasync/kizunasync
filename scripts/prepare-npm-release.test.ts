/// <reference types="bun" />
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { assertNoResidualPrivateSpecifiers, composePublishedPackageJson, exportTargets, findResidualPrivateSpecifiers, packedPathOfExport, placeWorkspace, PRIVATE_LAYOUT, privateSpecifierTargets, PUBLISHED_LAYOUT, rewritePrivateSpecifiers, rewriteStagedSpecifiers, unionDependencies, validatePublishedExports, validateStagedPack, validateStagedReactNativeModule, type IPackageJson, type IWorkspaceLayout } from './prepare-npm-release'

const REPO_ROOT = resolve(import.meta.dir, '..')

const readPackageJson = (dir: string): IPackageJson => JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf8')) as IPackageJson

const PRIVATE_PACKAGES = PRIVATE_LAYOUT.map((layout) => readPackageJson(layout.dir))
const PUBLIC_PACKAGE = readPackageJson('packages/kizunasync')
const PUBLISHED_EXPORTS = PUBLIC_PACKAGE.publishConfig?.exports ?? {}
const TARGETS = privateSpecifierTargets(PRIVATE_LAYOUT.map((layout, index) => ({ layout, exports: PRIVATE_PACKAGES[index]?.exports ?? {} })))

const TEMP_ROOTS: string[] = []

const rewrite = (file: string, text: string): string => rewritePrivateSpecifiers({ file, text, targets: TARGETS })

const tempRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix))

  TEMP_ROOTS.push(root)

  return root
}

const writeFixture = (root: string, path: string, text = ''): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

/** What `npm pack` of `layout`'s workspace would extract: every dev export's packed file, plus each placement's root. */
const packFixture = (root: string, layout: IWorkspaceLayout, pkg: IPackageJson | undefined): void => {
  for (const target of exportTargets(pkg?.exports ?? {})) {
    const packedPath = packedPathOfExport(layout, target)

    writeFixture(root, packedPath)

    if (layout.isBuilt) {
      writeFixture(root, packedPath.replace(/\.js$/, '.d.ts'))
    }
  }
  for (const { from } of layout.placements) {
    if (!existsSync(join(root, from))) {
      writeFixture(root, from.includes('.') ? from : join(from, '.keep'))
    }
  }
}

afterEach(() => {
  for (const root of TEMP_ROOTS.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('private specifier rewrite', () => {
  test('compiled JavaScript reaches a built workspace through its .js path', () => {
    expect(rewrite('dist/supabase/index.js', 'import { createKizunaSync } from "@kizunasync/core";')).toBe('import { createKizunaSync } from "../core/index.js";')
  })

  test('a declaration file reaches a built subpath through its .js path, inline type imports included', () => {
    const text = "import type { IStoreLocator } from '@kizunasync/core';\nexport declare const config: import(\"@kizunasync/core/config\").TKizunaSyncConfig;"

    expect(rewrite('dist/react/provider.d.ts', text)).toBe("import type { IStoreLocator } from '../core/index.js';\nexport declare const config: import(\"../core/config/index.js\").TKizunaSyncConfig;")
  })

  test('TypeScript source reaches TypeScript source without an extension', () => {
    expect(rewrite('dist/expo/web-driver.ts', "export { openWebDriver } from '@kizunasync/web'")).toBe("export { openWebDriver } from '../web/index'")
    expect(rewrite('dist/expo/store-locator.ts', "import { loadUniffi } from '@kizunasync/rn-uniffi'")).toBe("import { loadUniffi } from '../../src/index'")
  })

  test('TypeScript source reaches a built workspace through its .js path', () => {
    expect(rewrite('dist/expo/index.ts', "import { SCHEMA } from '@kizunasync/core/constants'")).toBe("import { SCHEMA } from '../core/constants.js'")
  })

  test('the wasm asset keeps its file name', () => {
    const text = "const registered = require('@kizunasync/web/wasm/kizunasync_wasm_bg.wasm')"

    expect(rewrite('dist/expo/wasm-asset.web.ts', text)).toBe("const registered = require('../web/wasm/kizunasync_wasm_bg.wasm')")
  })

  test('compiled output that reaches TypeScript source stops the run, naming the file and the specifier', () => {
    expect(() => rewrite('dist/react/index.js', 'import { openWebDriver } from "@kizunasync/web";')).toThrow(/dist\/react\/index\.js imports @kizunasync\/web/)
  })

  test('platform package names built in template literals are left alone', () => {
    const text = 'const name = `@kizunasync/${triple}`'

    expect(rewrite('dist/core/index.js', text)).toBe(text)
  })
})

describe('residual private specifiers', () => {
  test('a specifier no workspace exports survives the rewrite and stops the run', () => {
    const root = tempRoot('kizunasync-release-residual-')

    writeFixture(root, 'dist/supabase/index.js', 'import { a } from "@kizunasync/core";\nimport { b } from "@kizunasync/core/internal";\n')
    writeFixture(root, 'dist/expo/index.ts', "export * from '@kizunasync/web'\n")
    rewriteStagedSpecifiers(root, TARGETS)

    expect(readFileSync(join(root, 'dist/expo/index.ts'), 'utf8')).toBe("export * from '../web/index'\n")
    expect(findResidualPrivateSpecifiers(root)).toEqual(['dist/supabase/index.js'])
    expect(() => assertNoResidualPrivateSpecifiers(root)).toThrow(/dist\/supabase\/index\.js/)
  })

  test('only code files are checked, and a literal with spaces or backticks is not a specifier', () => {
    const root = tempRoot('kizunasync-release-residual-')

    writeFixture(root, 'dist/supabase/index.js.map', JSON.stringify({ sourcesContent: ["import { a } from '@kizunasync/core'"] }))
    writeFixture(root, 'dist/web/file-store.ts', "throw new Error('@kizunasync/web file store: empty path')\n")
    writeFixture(root, 'dist/core/index.d.ts', '/** The harness lives in `@kizunasync/core/conformance`. */\n')
    writeFixture(root, 'dist/expo/index.ts', "export * from '@kizunasync/expo/'\n")
    writeFixture(root, 'dist/react/index.d.ts', 'export type { IKizunaSync } from "@kizunasync/core/config";\n')

    expect(findResidualPrivateSpecifiers(root)).toEqual(['dist/react/index.d.ts'])
  })
})

describe('dependency composition', () => {
  const pkg = (name: string, dependencies: Record<string, string>): IPackageJson => ({ name, version: '0.0.0', dependencies })

  test('the union keeps one range per name and drops workspace ranges', () => {
    const union = unionDependencies([pkg('@kizunasync/a', { adze: '^2.3.0', '@kizunasync/core': 'workspace:*' }), pkg('@kizunasync/b', { adze: '^2.3.0', zod: '4.0.0' })], 'dependencies')

    expect(union).toEqual({ adze: '^2.3.0', zod: '4.0.0' })
  })

  test('two ranges for one name stop the run and name both', () => {
    expect(() => unionDependencies([pkg('@kizunasync/a', { adze: '^2.3.0' }), pkg('@kizunasync/b', { adze: '^3.0.0' })], 'dependencies')).toThrow('dependencies conflict for adze: @kizunasync/a declares ^2.3.0, @kizunasync/b declares ^3.0.0')
  })

  test('a peer range conflict stops the run too', () => {
    const peers = (name: string, range: string): IPackageJson => ({ name, version: '0.0.0', peerDependencies: { react: range } })

    expect(() => unionDependencies([peers('@kizunasync/a', '>=19'), peers('@kizunasync/b', '>=18')], 'peerDependencies')).toThrow('peerDependencies conflict for react')
  })

  test('the published manifest composes the workspaces, marks every peer optional, and pins the platform packages', () => {
    const composed = composePublishedPackageJson({ version: '1.2.3', publicPackage: PUBLIC_PACKAGE, privatePackages: PRIVATE_PACKAGES, files: ['LICENSE', 'dist'] })
    const rnUniffi = PRIVATE_PACKAGES.find((candidate) => candidate.name === '@kizunasync/rn-uniffi')

    expect(composed.dependencies).toEqual(unionDependencies(PRIVATE_PACKAGES, 'dependencies'))
    expect(Object.values(composed.dependencies ?? {}).some((range) => range.startsWith('workspace:'))).toBe(false)
    expect(Object.keys(composed.peerDependencies ?? {}).sort()).toEqual(Object.keys(unionDependencies(PRIVATE_PACKAGES, 'peerDependencies')).sort())
    expect(Object.values(composed.peerDependenciesMeta as Record<string, { optional: boolean }>).every(({ optional }) => optional)).toBe(true)
    expect(Object.keys(composed.peerDependenciesMeta as Record<string, unknown>)).toEqual(Object.keys(composed.peerDependencies ?? {}))
    expect(composed.optionalDependencies).toEqual({
      '@kizunasync/darwin-arm64': '1.2.3',
      '@kizunasync/darwin-x64': '1.2.3',
      '@kizunasync/linux-x64-gnu': '1.2.3',
      '@kizunasync/linux-arm64-gnu': '1.2.3',
      '@kizunasync/win32-x64-msvc': '1.2.3',
    })
    expect(composed.codegenConfig).toEqual(rnUniffi?.codegenConfig)
    expect(composed.exports).toEqual(PUBLISHED_EXPORTS)
    expect(composed.bin).toEqual(PUBLIC_PACKAGE.bin)
  })
})

describe('React Native module validation', () => {
  const RN_MODULE = ['RnUniffi.podspec', 'ios/RnUniffi.mm', 'android/build.gradle', 'src/generated/NativeRnUniffi.ts', 'src/generated/cpp/kizunasync_ffi.cpp']

  test('a staged tree with the podspec, native sources, and generated bindings passes', () => {
    const root = tempRoot('kizunasync-release-rn-')

    for (const path of RN_MODULE) {
      writeFixture(root, path)
    }

    expect(() => validateStagedReactNativeModule(root)).not.toThrow()
  })

  test.each(RN_MODULE)('a staged tree without %s stops the run', (absent) => {
    const root = tempRoot('kizunasync-release-rn-')

    for (const path of RN_MODULE.filter((candidate) => candidate !== absent)) {
      writeFixture(root, path)
    }
    writeFixture(root, 'src/generated/cpp/README.md')

    expect(() => validateStagedReactNativeModule(root)).toThrow(absent.endsWith('.cpp') ? 'src/generated/cpp/*.cpp' : absent)
  })
})

describe('SQL pack validation', () => {
  const MANIFEST = JSON.stringify({ pack: ['0001_kizuna_init.sql'], demo: ['0002_example.sql'] })
  const SQL = 'create schema kizunasync;\n'

  // A source SQL pack and a staged kizunasync whose pack/ copies it.
  const packFixtures = (): { stagedRoot: string; supabasePackRoot: string } => {
    const supabasePackRoot = tempRoot('kizunasync-release-pack-source-')
    const stagedRoot = tempRoot('kizunasync-release-pack-staged-')

    writeFixture(supabasePackRoot, 'pack.manifest.json', MANIFEST)
    writeFixture(supabasePackRoot, 'supabase/migrations/0001_kizuna_init.sql', SQL)
    writeFixture(stagedRoot, 'pack/pack.manifest.json', MANIFEST)
    writeFixture(stagedRoot, 'pack/0001_kizuna_init.sql', SQL)

    return { stagedRoot, supabasePackRoot }
  }

  test('a staged pack that copies the source passes', () => {
    const { stagedRoot, supabasePackRoot } = packFixtures()

    expect(() => validateStagedPack(stagedRoot, supabasePackRoot)).not.toThrow()
  })

  test('a staged pack file with one changed byte stops the run and names it', () => {
    const { stagedRoot, supabasePackRoot } = packFixtures()

    writeFixture(stagedRoot, 'pack/0001_kizuna_init.sql', SQL.replace('k', 'K'))

    expect(() => validateStagedPack(stagedRoot, supabasePackRoot)).toThrow('pack/0001_kizuna_init.sql')
  })

  test('a missing staged pack file stops the run and names the build to run', () => {
    const { stagedRoot, supabasePackRoot } = packFixtures()

    rmSync(join(stagedRoot, 'pack/0001_kizuna_init.sql'))

    expect(() => validateStagedPack(stagedRoot, supabasePackRoot)).toThrow('pack/0001_kizuna_init.sql')
    expect(() => validateStagedPack(stagedRoot, supabasePackRoot)).toThrow('bun run turbo run build --filter=kizunasync...')
  })

  test('a staged manifest that differs from the source stops the run', () => {
    const { stagedRoot, supabasePackRoot } = packFixtures()

    writeFixture(stagedRoot, 'pack/pack.manifest.json', JSON.stringify({ pack: [] }))

    expect(() => validateStagedPack(stagedRoot, supabasePackRoot)).toThrow('pack/pack.manifest.json')
  })
})

describe('published layout', () => {
  test('every published exports target sits under a placement of the layout table', () => {
    const placed = PUBLISHED_LAYOUT.flatMap(({ placements }) => placements.map(({ to }) => to))
    const uncovered = exportTargets(PUBLISHED_EXPORTS)
      .map((target) => target.replace(/^\.\//, ''))
      .filter((target) => target !== 'package.json' && !placed.some((to) => target === to || target.startsWith(`${to}/`)))

    expect(uncovered).toEqual([])
  })

  test('a staged fixture carries every published exports target', () => {
    const root = tempRoot('kizunasync-release-layout-')
    const stagedRoot = join(root, 'kizunasync')

    mkdirSync(stagedRoot)

    for (const layout of PUBLISHED_LAYOUT) {
      const packedDir = join(root, 'packed', layout.dir)
      const pkg = layout.name === 'kizunasync' ? undefined : PRIVATE_PACKAGES[PRIVATE_LAYOUT.indexOf(layout)]

      packFixture(packedDir, layout, pkg)
      placeWorkspace(layout, packedDir, stagedRoot)
    }
    writeFixture(stagedRoot, 'package.json', '{}')

    expect(() => validatePublishedExports(stagedRoot, PUBLISHED_EXPORTS)).not.toThrow()
    expect(Object.keys(PUBLISHED_EXPORTS).sort()).toEqual([...Object.keys(PUBLIC_PACKAGE.exports ?? {}), './web/wasm/kizunasync_wasm_bg.wasm'].sort())
  })

  test('a published target the staged tree lacks stops the run', () => {
    const root = tempRoot('kizunasync-release-layout-')

    expect(() => validatePublishedExports(root, { './vue': { types: './dist/vue/index.d.ts', default: './dist/vue/index.js' } })).toThrow('./dist/vue/index.js')
  })
})
