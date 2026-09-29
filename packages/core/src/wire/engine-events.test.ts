import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EEngineEventType } from './types'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

describe('engine event vocabulary', () => {
  test('EEngineEventType equals the producer list, and the transcript enum is that list minus LOCAL_CHANGED', () => {
    const listed = JSON.parse(
      readFileSync(join(ROOT, 'packages/protocol/spec/engine-events.json'), 'utf8'),
    ) as { producer: string[] }

    expect<string[]>([...Object.values(EEngineEventType)].sort()).toEqual([...listed.producer].sort())
    const schema = JSON.parse(
      readFileSync(join(ROOT, 'packages/protocol/schemas/transcript.schema.json'), 'utf8'),
    ) as {
      $defs: { check: { oneOf: Array<{ properties?: { event?: { enum?: string[] } } }> } }
    }
    const eventEnum = schema.$defs.check.oneOf.find((arm) => arm.properties?.event?.enum)?.properties
      ?.event?.enum

    expect(eventEnum).toBeDefined()
    expect([...eventEnum!, 'LOCAL_CHANGED'].sort()).toEqual([...listed.producer].sort())
  })
})
