import { describe, expect, test } from 'bun:test'
import { readAlternatives } from '@/lib/comparison'

describe('readAlternatives', () => {
  test('returns the eleven product sections of the docs comparison page in order', () => {
    expect(readAlternatives().map((section) => section.id)).toEqual(['powersync', 'electric', 'zero', 'legend-state', 'rxdb', 'watermelondb', 'tinybase', 'triplit', 'instantdb', 'firestore', 'a-typical-custom-implementation'])
  })

  test('keeps the H3 sub-sections inside each body', () => {
    const [powersync] = readAlternatives()

    expect(powersync?.heading).toBe('PowerSync')
    expect(powersync?.bodyMarkdown).toContain('### How Kizuna differs')
    expect(powersync?.bodyMarkdown).toContain('### Choose PowerSync when')
  })
})
