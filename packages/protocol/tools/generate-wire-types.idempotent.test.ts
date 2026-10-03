import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderWireTypes } from './generate-wire-types'

const ROOT = join(import.meta.dir, '..')
const SCHEMAS = join(ROOT, 'schemas')
const PROTO = join(ROOT, 'spec', 'wire-types.ts')
const CORE = join(ROOT, '..', 'core', 'src', 'wire', 'wire-types.generated.ts')

const stripBanner = (s: string): string => s.replace(/^\/\*\*\n(?: \*[^\n]*\n)* \*\/\n\n/, '')

describe('generate-wire-types is deterministic', () => {
  test('the committed mirrors equal a fresh render', () => {
    const rendered = renderWireTypes(SCHEMAS)

    expect(readFileSync(PROTO, 'utf8')).toBe(rendered.proto)
    expect(readFileSync(CORE, 'utf8')).toBe(rendered.core)
  })

  test('both mirrors share an identical body (only the banner differs)', () => {
    const rendered = renderWireTypes(SCHEMAS)

    expect(stripBanner(rendered.proto)).toBe(stripBanner(rendered.core))
    expect(stripBanner(readFileSync(PROTO, 'utf8'))).toBe(stripBanner(readFileSync(CORE, 'utf8')))
  })
})
