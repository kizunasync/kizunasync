/// <reference types="bun" />
/**
 * Every app copies its favicons from branding/ instead of pointing at it
 * directly, so a copy can silently drift from its source. This pins every
 * copy byte-identical to the branding file it comes from.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')

const APPS = [
  'apps/website',
  'apps/sync-inspector',
  'apps/demo',
  'examples/todo-react',
  'examples/todo-vue',
  'examples/todo-expo',
]

const FAVICON_FILES = [
  'favicon.svg',
  'favicon-light.svg',
  'favicon-dark-32.png',
  'favicon-dark-180.png',
  'favicon-light-32.png',
  'favicon-light-180.png',
  'apple-touch-icon.png',
]

describe('favicon copies match their branding source', () => {
  for (const file of FAVICON_FILES) {
    const source = readFileSync(resolve(repo, 'branding', file))

    for (const app of APPS) {
      test(`${app}/public/${file}`, () => {
        const copy = readFileSync(resolve(repo, app, 'public', file))

        expect(copy.equals(source)).toBe(true)
      })
    }
  }
})
