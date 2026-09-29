import { describe, expect, test } from 'bun:test'
import { activeJourneyIndex, journeyBarProgress, sectionScrollProgress } from './journey-progress'

describe('sectionScrollProgress', () => {
  test('is 0 while the section sits fully below the read line', () => {
    expect(sectionScrollProgress(400, 200, 160)).toBe(0)
  })

  test('is 0 when the section top is exactly on the read line', () => {
    expect(sectionScrollProgress(160, 200, 160)).toBe(0)
  })

  test('interpolates through the section body', () => {
    expect(sectionScrollProgress(60, 200, 160)).toBe(0.5)
    expect(sectionScrollProgress(110, 200, 160)).toBe(0.25)
    expect(sectionScrollProgress(10, 200, 160)).toBe(0.75)
  })

  test('is 1 when the section bottom is exactly on the read line', () => {
    expect(sectionScrollProgress(-40, 200, 160)).toBe(1)
  })

  test('stays 1 after the section has scrolled fully past the read line', () => {
    expect(sectionScrollProgress(-400, 200, 160)).toBe(1)
  })

  test('is 0 for empty or inverted boxes', () => {
    expect(sectionScrollProgress(0, 0, 160)).toBe(0)
    expect(sectionScrollProgress(0, -20, 160)).toBe(0)
  })

  test('rounds mid values to three decimals', () => {
    expect(sectionScrollProgress(160 - 200 / 3, 200, 160)).toBe(0.333)
  })
})

describe('journeyBarProgress', () => {
  test('is 0 with no sections', () => {
    expect(journeyBarProgress([])).toBe(0)
  })

  test('averages per-section progress so each nav block is one equal third', () => {
    expect(journeyBarProgress([0, 0, 0])).toBe(0)
    expect(journeyBarProgress([0.5, 0, 0])).toBe(0.167)
    expect(journeyBarProgress([1, 0, 0])).toBe(0.333)
    expect(journeyBarProgress([1, 0.5, 0])).toBe(0.5)
    expect(journeyBarProgress([1, 1, 0])).toBe(0.667)
    expect(journeyBarProgress([1, 1, 0.5])).toBe(0.833)
    expect(journeyBarProgress([1, 1, 1])).toBe(1)
  })
})

describe('activeJourneyIndex', () => {
  test('stays on the first step before any section has been reached', () => {
    expect(activeJourneyIndex([])).toBe(0)
    expect(activeJourneyIndex([0, 0, 0])).toBe(0)
  })

  test('tracks the section currently being read', () => {
    expect(activeJourneyIndex([0.4, 0, 0])).toBe(0)
    expect(activeJourneyIndex([1, 0.3, 0])).toBe(1)
    expect(activeJourneyIndex([1, 1, 0.2])).toBe(2)
  })

  test('keeps the last completed step while the next has not started', () => {
    expect(activeJourneyIndex([1, 0, 0])).toBe(0)
    expect(activeJourneyIndex([1, 1, 0])).toBe(1)
  })

  test('stays on the last step once the journey is complete', () => {
    expect(activeJourneyIndex([1, 1, 1])).toBe(2)
  })
})
