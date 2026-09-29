import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { headingSlug } from '@kizunasync/protocol/heading-slug'
import { headingIds } from './heading-ids'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const DX_AT_HEADINGS: { file: string; token: string }[] = [
  { file: 'docs/sync/offline-writes.md', token: 'offline-writes' },
  { file: 'docs/operations/test-offline-behavior.md', token: 'test-offline-behavior' },
  { file: 'docs/attachments/media-and-attachments.md', token: 'media-attachments' },
]

describe('DX and AT cite slugs match published heading ids', () => {
  test('headingSlug equals headingIds for each DX/AT H1', () => {
    for (const { file, token } of DX_AT_HEADINGS) {
      const raw = readFileSync(join(REPO_ROOT, file), 'utf8')
      const body = raw.replace(/^---[\s\S]*?---\n/, '')
      const h1 = headingIds(body).find((heading) => heading.depth === 1)

      expect(h1, file).toBeDefined()
      expect(h1!.id, file).toBe(token)
      expect(headingSlug(`# ${h1!.text}`), file).toBe(h1!.id)
    }
  })
})
