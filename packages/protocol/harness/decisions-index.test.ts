import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020'

const ROOT = join(import.meta.dir, '..')
const readJson = (rel: string): unknown =>
  JSON.parse(readFileSync(join(ROOT, ...rel.split('/')), 'utf8')) as unknown

describe('decisions-index ajv', () => {
  const ajv = new Ajv2020({ strict: false })
  const schema = readJson('schemas/decisions-index.schema.json')
  const validate = ajv.compile(schema as object)

  test('the schema compiles under ajv 2020', () => {
    expect(typeof validate).toBe('function')
  })

  test('a representative index validates', () => {
    const sample = {
      'D-cursor-opaque-token': {
        title: 'The cursor is an opaque text token',
        status: 'decided',
        file: 'decisions/D-cursor-opaque-token.md',
      },
      'D-base-hint': {
        title: 'base_hint shape and semantics',
        status: 'open',
        file: 'decisions/D-base-hint.md',
      },
    }

    expect(validate(sample)).toBe(true)
  })

  test('an unknown status is rejected', () => {
    expect(
      validate({
        'D-cursor-opaque-token': {
          title: 't',
          status: 'maybe',
          file: 'decisions/D-cursor-opaque-token.md',
        },
      }),
    ).toBe(false)
  })

  test('a non-slug key is rejected', () => {
    expect(
      validate({
        'not-a-decision': {
          title: 't',
          status: 'decided',
          file: 'decisions/D-cursor-opaque-token.md',
        },
      }),
    ).toBe(false)
  })

  test('the real index.json validates once built', () => {
    if (!existsSync(join(ROOT, 'decisions', 'index.json'))) {
      return
    }
    expect(validate(readJson('decisions/index.json'))).toBe(true)
  })
})
