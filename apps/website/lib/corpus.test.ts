import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { corpusCaseCount, executedCaseCount } from './corpus'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const manifestPath = resolve(repo, 'packages/protocol/cases/manifest.json')
const scenariosPath = resolve(repo, 'crates/kizunasync-scenarios/scenarios.json')

interface IManifestCase {
  file: string | null
}

interface IScenariosFile {
  scenarios: unknown[]
}

describe('protocol corpus stats', () => {
  test('corpusCaseCount and executedCaseCount match the manifest', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { cases: IManifestCase[] }

    expect(corpusCaseCount()).toBe(manifest.cases.length)
    expect(executedCaseCount()).toBe(manifest.cases.filter((entry) => entry.file !== null).length)
    expect(executedCaseCount()).toBeLessThanOrEqual(corpusCaseCount())
  })

  test('the landing page reads the count from the helper, not a literal', () => {
    const source = readFileSync(resolve(repo, 'apps/website/components/home/key-numbers-section.tsx'), 'utf8')

    expect(source).toContain('corpusCaseCount()')
    expect(/value=\{\d+\}\s*label="protocol corpus cases"/.test(source)).toBe(false)
  })

  test('docs that spell the corpus census match the manifest', () => {
    const total = String(corpusCaseCount())
    const executed = String(executedCaseCount())
    const skipped = String(corpusCaseCount() - executedCaseCount())
    const files = [
      'docs/getting-started/status.md',
      'docs/resources/roadmap.md',
      'docs/operations/ci-cd.md',
      'docs/sync/protocol-overview.md',
      'docs/reference/protocol.md',
      'docs/operations/test-offline-behavior.md',
    ]

    for (const rel of files) {
      const text = readFileSync(resolve(repo, rel), 'utf8')

      expect(text, rel).toContain(total)
      expect(text, rel).toContain(executed)
    }
    expect(skipped).toBe('1')
  })

  test('protocol-overview pins the shared scenario count from scenarios.json', () => {
    const scenarios = JSON.parse(readFileSync(scenariosPath, 'utf8')) as IScenariosFile
    const count = scenarios.scenarios.length
    const overview = readFileSync(resolve(repo, 'docs/sync/protocol-overview.md'), 'utf8')

    expect(overview).toContain(
      `replay the ${count} shared scenarios in \`crates/kizunasync-scenarios/scenarios.json\``,
    )
  })

  test('status.md TLA count matches properties/index.json', () => {
    const index = JSON.parse(
      readFileSync(resolve(repo, 'packages/protocol/properties/index.json'), 'utf8'),
    ) as Record<string, { tla?: string }>
    const count = Object.values(index).filter((entry) => typeof entry.tla === 'string').length
    const status = readFileSync(resolve(repo, 'docs/getting-started/status.md'), 'utf8')
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

    expect(status).toContain(`${words[count]} TLA+`)
  })

  test('the landing page RPC count matches the protocol reference table', () => {
    const protocol = readFileSync(resolve(repo, 'docs/reference/protocol.md'), 'utf8')
    const surface = protocol.split('## Authenticated SQL surface')[1]?.split('\n## ')[0] ?? ''
    const rpcCount = [...surface.matchAll(/^\| \[`kizunasync\.\w+`\]/gm)].length
    const source = readFileSync(resolve(repo, 'apps/website/components/home/key-numbers-section.tsx'), 'utf8')
    const match = source.match(/value=\{(\d+)\}\s*label="authenticated public RPCs"/)

    expect(match).not.toBeNull()
    expect(Number(match?.[1])).toBe(rpcCount)
  })
})
