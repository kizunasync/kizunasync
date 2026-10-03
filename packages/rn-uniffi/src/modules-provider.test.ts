/// <reference types="bun" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const PACKAGE_ROOT = join(import.meta.dir, '..')

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** React Native codegen registers a third-party Turbo Module on iOS only from this `codegenConfig` mapping. */
const readModulesProvider = (): Record<string, unknown> => {
  const manifest: unknown = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  const codegenConfig = isRecord(manifest) ? manifest.codegenConfig : undefined
  const ios = isRecord(codegenConfig) ? codegenConfig.ios : undefined
  const modulesProvider = isRecord(ios) ? ios.modulesProvider : undefined

  if (isRecord(modulesProvider)) {
    return modulesProvider
  }

  throw new Error('packages/rn-uniffi/package.json has no codegenConfig.ios.modulesProvider')
}

const readMatch = (relativePath: string, pattern: RegExp): string => {
  const match = pattern.exec(readFileSync(join(PACKAGE_ROOT, relativePath), 'utf8'))

  if (match?.[1] === undefined) {
    throw new Error(`${relativePath} does not match ${pattern}`)
  }

  return match[1]
}

describe('iOS Turbo Module registration', () => {
  const registeredName = readMatch('src/generated/NativeRnUniffi.ts', /getEnforcing<Spec>\('([^']+)'\)/)

  test('codegenConfig.ios.modulesProvider maps the module name the spec registers', () => {
    expect(Object.keys(readModulesProvider())).toEqual([registeredName])
  })

  test('the mapped class is the @implementation in ios/RnUniffi.mm', () => {
    const implementedClass = readMatch('ios/RnUniffi.mm', /^@implementation\s+(\w+)\s*$/m)

    expect(readModulesProvider()[registeredName]).toBe(implementedClass)
  })
})
