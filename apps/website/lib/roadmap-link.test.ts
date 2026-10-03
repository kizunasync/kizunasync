import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { headingIds } from './heading-ids'
import { parseDocSource } from './docs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')

describe('roadmap links pin a real heading id', () => {
  test('TANSTACK_ROADMAP_SLUG in components/home/journey.data.ts matches headingIds() for "TanStack DB adapter"', () => {
    const roadmap = readFileSync(resolve(repo, 'docs/resources/roadmap.md'), 'utf8')
    const { content } = parseDocSource(roadmap)
    const heading = headingIds(content).find((entry) => entry.text.trim() === 'TanStack DB adapter')

    expect(heading).toBeDefined()

    const pageSource = readFileSync(resolve(repo, 'apps/website/components/home/journey.data.ts'), 'utf8')
    const match = /TANSTACK_ROADMAP_SLUG = '([^']+)'/.exec(pageSource)

    expect(match).not.toBeNull()
    expect(match![1]).toBe(heading!.id)
  })
})
