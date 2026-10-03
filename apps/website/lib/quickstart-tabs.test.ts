import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const componentSource = readFileSync(resolve(repo, 'apps/website/components/quickstart-tabs.tsx'), 'utf8')

/** Every quickstart tab's real client-bootstrap guide, by label. */
const GUIDE_FILES: Record<string, string> = {
  React: 'docs/getting-started/react.md',
  Vue: 'docs/getting-started/vue.md',
  'Expo/React Native': 'docs/getting-started/expo.md',
  Swift: 'docs/getting-started/native-clients.md',
  Kotlin: 'docs/getting-started/native-clients.md',
  'Vanilla / other': 'docs/getting-started/vanilla-js.md',
}

function parseSnippets(source: string): Array<[string, string]> {
  const pattern = /label:\s*'([^']+)'[\s\S]*?code:\s*`([\s\S]*?)`,\n {2}\},/g

  return [...source.matchAll(pattern)].map((match) => [match[1]!, match[2]!])
}

/** camelCase, PascalCase, or snake_case tokens; skips plain lowercase prose words. */
function extractIdentifiers(code: string): string[] {
  const tokens = code.match(/[A-Za-z_][A-Za-zA-Z0-9_]*/g) ?? []
  const identifiers = tokens.filter(
    (token) => token.length > 2 && (/[a-z][A-Z]/.test(token) || /^[A-Z]/.test(token) || token.includes('_')),
  )

  return [...new Set(identifiers)]
}

describe('quickstart tabs follow their runtime guides', () => {
  const snippets = parseSnippets(componentSource)

  test('every snippet label has a known guide', () => {
    expect(snippets.length).toBeGreaterThan(0)

    for (const [label] of snippets) {
      expect(Object.keys(GUIDE_FILES)).toContain(label)
    }
  })

  for (const [label, code] of snippets) {
    test(`${label} tab: every identifier appears in its guide`, () => {
      const guideFile = GUIDE_FILES[label]

      expect(guideFile).toBeDefined()
      const guide = readFileSync(resolve(repo, guideFile!), 'utf8')
      const identifiers = extractIdentifiers(code)

      expect(identifiers.length).toBeGreaterThan(0)

      for (const identifier of identifiers) {
        expect(guide.includes(identifier)).toBe(true)
      }
    })
  }
})
