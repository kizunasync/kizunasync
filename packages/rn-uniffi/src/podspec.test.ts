/// <reference types="bun" />
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

const PACKAGE_ROOT = join(import.meta.dir, '..')
const IOS_FLOOR_SCRIPT = join(PACKAGE_ROOT, '..', '..', 'scripts', 'swift-package', 'ios-floor.sh')
const VENDORED_XCFRAMEWORK = 'build/KizunaSyncFfi.xcframework'
const ENGINE_PACKAGE_URL = 'https://github.com/kizunasync/kizunasync-swift'
const LOCAL_ENGINE_PACKAGE = '/opt/kizunasync-swift'

/**
 * Evaluates the podspec named by the first argument the way CocoaPods does, against a `Pod::Spec` stub that records
 * every attribute. `spm_dependency` stands in for React Native's Podfile helper and records its calls; it exists only
 * when PODSPEC_STUB_SPM is 1, which is how a podspec evaluated outside a React Native Podfile sees the world.
 */
const RUBY_HARNESS = `
require "json"

module Pod
  class Spec
    attr_reader :attributes

    def initialize
      @attributes = { "dependencies" => [] }
      yield self
    end

    def dependency(*args)
      @attributes["dependencies"] << args
    end

    def method_missing(name, *args)
      return @attributes[name.to_s.delete_suffix("=")] = args.first if name.end_with?("=")
      return @attributes.fetch(name.to_s) if args.empty? && @attributes.key?(name.to_s)

      super
    end

    def respond_to_missing?(name, include_private = false)
      name.end_with?("=") || @attributes.key?(name.to_s) || super
    end
  end
end

$spm_calls = []

def install_modules_dependencies(spec); end

if ENV["PODSPEC_STUB_SPM"] == "1"
  def spm_dependency(spec, url:, requirement:, products:)
    $spm_calls << { url: url, requirement: requirement, products: products }
  end
end

path = ARGV.fetch(0)
spec = eval(File.read(path), TOPLEVEL_BINDING, path)
puts JSON.generate({ attributes: spec.attributes, spm: $spm_calls })
`

interface IPodspecRun {
  exitCode: number
  stdout: string
  stderr: string
}

interface IPodspecSetup {
  hasXcframework: boolean
  hasSpmHelper: boolean
  swiftPackagePath?: string
}

let stagedRoot: string | undefined

afterEach(() => {
  if (stagedRoot !== undefined) {
    rmSync(stagedRoot, { recursive: true, force: true })
    stagedRoot = undefined
  }
})

const readPackageVersion = (): string => {
  const manifest: unknown = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))

  if (typeof manifest === 'object' && manifest !== null && 'version' in manifest && typeof manifest.version === 'string') {
    return manifest.version
  }

  throw new Error('packages/rn-uniffi/package.json has no string version')
}

/** Copies the podspec and its package.json into a scratch package root so the xcframework check sees only this setup. */
const stagePackage = (hasXcframework: boolean): string => {
  const root = mkdtempSync(join(tmpdir(), 'kizunasync-podspec-'))

  stagedRoot = root
  cpSync(join(PACKAGE_ROOT, 'RnUniffi.podspec'), join(root, 'RnUniffi.podspec'))
  cpSync(join(PACKAGE_ROOT, 'package.json'), join(root, 'package.json'))

  if (hasXcframework) {
    mkdirSync(join(root, VENDORED_XCFRAMEWORK), { recursive: true })
  }

  return root
}

const evaluatePodspec = ({ hasXcframework, hasSpmHelper, swiftPackagePath }: IPodspecSetup): IPodspecRun => {
  const root = stagePackage(hasXcframework)
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', PODSPEC_STUB_SPM: hasSpmHelper ? '1' : '0' }

  if (swiftPackagePath !== undefined) {
    env.KIZUNASYNC_SWIFT_PACKAGE_PATH = swiftPackagePath
  }
  const run = Bun.spawnSync(['ruby', '-e', RUBY_HARNESS, join(root, 'RnUniffi.podspec')], { env })

  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() }
}

const parseRun = (run: IPodspecRun): unknown => JSON.parse(run.stdout)

describe('RnUniffi.podspec engine source', () => {
  test('vendors the monorepo xcframework before any Swift package', () => {
    const run = evaluatePodspec({ hasXcframework: true, hasSpmHelper: true, swiftPackagePath: LOCAL_ENGINE_PACKAGE })

    expect(run.stderr).toBe('')
    expect(run.exitCode).toBe(0)
    expect(parseRun(run)).toMatchObject({ attributes: { vendored_frameworks: VENDORED_XCFRAMEWORK }, spm: [] })
  })

  test('links KizunaSyncEngine from the checkout KIZUNASYNC_SWIFT_PACKAGE_PATH names', () => {
    const run = evaluatePodspec({ hasXcframework: false, hasSpmHelper: true, swiftPackagePath: LOCAL_ENGINE_PACKAGE })
    const evaluation = parseRun(run)

    expect(run.exitCode).toBe(0)
    expect(evaluation).toMatchObject({ spm: [{ url: LOCAL_ENGINE_PACKAGE, products: ['KizunaSyncEngine'] }] })
    expect(evaluation).not.toHaveProperty('attributes.vendored_frameworks')
  })

  test('links KizunaSyncEngine from kizunasync-swift at exactly the package version otherwise', () => {
    const run = evaluatePodspec({ hasXcframework: false, hasSpmHelper: true })
    const evaluation = parseRun(run)
    const requirement = { kind: 'exactVersion', version: readPackageVersion() }

    expect(run.exitCode).toBe(0)
    expect(evaluation).toMatchObject({ spm: [{ url: ENGINE_PACKAGE_URL, requirement, products: ['KizunaSyncEngine'] }] })
    expect(evaluation).not.toHaveProperty('attributes.vendored_frameworks')
  })

  test('an empty KIZUNASYNC_SWIFT_PACKAGE_PATH counts as unset', () => {
    const run = evaluatePodspec({ hasXcframework: false, hasSpmHelper: true, swiftPackagePath: '' })

    expect(run.exitCode).toBe(0)
    expect(parseRun(run)).toMatchObject({ spm: [{ url: ENGINE_PACKAGE_URL }] })
  })

  test('refuses to resolve a Swift package outside React Native Podfile helpers', () => {
    const run = evaluatePodspec({ hasXcframework: false, hasSpmHelper: false })

    expect(run.exitCode).not.toBe(0)
    expect(run.stderr).toContain('spm_dependency')
    expect(run.stderr).toContain('React Native')
  })

  test('declares the iOS floor the Swift package template declares', () => {
    const floor = Bun.spawnSync(['bash', IOS_FLOOR_SCRIPT, 'ios'])
    const run = evaluatePodspec({ hasXcframework: true, hasSpmHelper: true })

    expect(floor.exitCode).toBe(0)
    expect(parseRun(run)).toMatchObject({ attributes: { platforms: { ios: floor.stdout.toString().trim() } } })
  })
})
