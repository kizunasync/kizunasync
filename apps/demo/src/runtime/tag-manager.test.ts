/// <reference types="bun" />
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

const MAIN_SOURCE = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')
const VERCEL_CONFIG: unknown = JSON.parse(readFileSync(new URL('../../public/vercel.json', import.meta.url), 'utf8'))

const TAG_MANAGER = 'https://www.googletagmanager.com'
const ANALYTICS_HOSTS = ['https://*.google-analytics.com', 'https://*.analytics.google.com']

const readContentSecurityPolicy = (): Map<string, string[]> => {
  const serialized = JSON.stringify(VERCEL_CONFIG)
  const policy = serialized.match(/"Content-Security-Policy","value":"([^"]+)"/)?.[1] ?? ''

  return new Map(
    policy
      .split(';')
      .map((directive) => directive.trim().split(/\s+/))
      .filter((tokens) => tokens.length > 0 && tokens[0] !== '')
      .map((tokens): [string, string[]] => [tokens[0] ?? '', tokens.slice(1)]),
  )
}

describe('tag manager boot', () => {
  test('main.tsx imports the boot module before anything else', () => {
    const firstImport = MAIN_SOURCE.split('\n').find((line) => line.startsWith('import '))

    expect(firstImport).toBe("import '@/runtime/tag-manager'")
  })

  test('the CSP admits Google Tag Manager for scripts, connections, images, and frames', () => {
    const policy = readContentSecurityPolicy()

    for (const directive of ['script-src', 'connect-src', 'img-src', 'frame-src']) {
      expect(policy.get(directive)).toContain(TAG_MANAGER)
    }
  })

  test('the CSP admits Google Analytics for connections and images only', () => {
    const policy = readContentSecurityPolicy()

    for (const directive of ['connect-src', 'img-src']) {
      expect(policy.get(directive)).toEqual(expect.arrayContaining(ANALYTICS_HOSTS))
    }
    for (const directive of ['script-src', 'frame-src', 'default-src', 'worker-src', 'style-src', 'font-src']) {
      for (const host of ANALYTICS_HOSTS) {
        expect(policy.get(directive)).not.toContain(host)
      }
    }
  })

  test('the CSP still admits no inline script', () => {
    expect(readContentSecurityPolicy().get('script-src')).not.toContain("'unsafe-inline'")
  })
})
