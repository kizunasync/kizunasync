import { describe, expect, test } from 'bun:test'
import { DESCRIPTION } from './site'
import { DESCRIPTION_MAX_LINES, descriptionFontSize, estimateLineCount, titleFontSize } from './og-text'

describe('titleFontSize', () => {
  test('uses the largest size for short titles', () => {
    expect(titleFontSize('Offline-first sync for Supabase')).toBe(72)
  })

  test('steps down as the title grows', () => {
    expect(titleFontSize('x'.repeat(33))).toBe(60)
    expect(titleFontSize('x'.repeat(57))).toBe(52)
  })

  test('floors at the minimum size', () => {
    expect(titleFontSize('x'.repeat(200))).toBe(46)
  })

  test('never grows with length', () => {
    let previous = Infinity

    for (let length = 1; length <= 120; length += 1) {
      const size = titleFontSize('x'.repeat(length))

      expect(size).toBeLessThanOrEqual(previous)
      previous = size
    }
  })
})

describe('descriptionFontSize', () => {
  test('keeps the home description within three lines without truncation', () => {
    const size = descriptionFontSize(DESCRIPTION)

    expect(DESCRIPTION.length).toBeGreaterThan(150)
    expect(estimateLineCount(DESCRIPTION, size)).toBeLessThanOrEqual(DESCRIPTION_MAX_LINES)
  })

  test('uses the largest size for short text', () => {
    expect(descriptionFontSize('Short text.')).toBe(30)
  })

  test('prefers two lines when a size fits them', () => {
    const size = descriptionFontSize('x'.repeat(164))

    expect(size).toBe(24)
    expect(estimateLineCount('x'.repeat(164), size)).toBe(2)
  })

  test('floors at the smallest size for absurd lengths', () => {
    expect(descriptionFontSize('x'.repeat(2000))).toBe(24)
  })
})
