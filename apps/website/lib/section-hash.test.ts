import { describe, expect, test } from 'bun:test'
import { activeSectionId, hashForSection, HOME_HASH_READ_LINE, isSamePageHashLink, stickyReadLine } from './section-hash'

describe('stickyReadLine', () => {
  test('uses the header offset while the journey nav is still down the page', () => {
    expect(stickyReadLine(900, 980, HOME_HASH_READ_LINE)).toBe(HOME_HASH_READ_LINE)
  })

  test('uses the stuck nav bottom once it has pinned under the header', () => {
    expect(stickyReadLine(80, 162, HOME_HASH_READ_LINE)).toBe(162)
    expect(stickyReadLine(79, 160, HOME_HASH_READ_LINE)).toBe(160)
  })

  test('ignores a nav that has not reached the sticky band', () => {
    expect(stickyReadLine(120, 200, HOME_HASH_READ_LINE)).toBe(HOME_HASH_READ_LINE)
  })
})

describe('activeSectionId', () => {
  const sections = [
    { id: 'home', top: 0 },
    { id: 'how-it-works', top: 700 },
    { id: 'cli', top: 900 },
    { id: 'api', top: 1400 },
    { id: 'quickstart', top: 1900 },
    { id: 'features', top: 2500 },
  ]

  test('returns null when there are no sections', () => {
    expect(activeSectionId([], 80)).toBe(null)
  })

  test('stays on the hero while later blocks are still below the read line', () => {
    expect(activeSectionId(sections, 80)).toBe('home')
  })

  test('advances to the last section whose top has crossed the read line', () => {
    expect(
      activeSectionId(
        [
          { id: 'home', top: -600 },
          { id: 'how-it-works', top: 40 },
          { id: 'cli', top: 240 },
        ],
        80,
      ),
    ).toBe('how-it-works')
    expect(
      activeSectionId(
        [
          { id: 'home', top: -1200 },
          { id: 'how-it-works', top: -200 },
          { id: 'cli', top: 20 },
          { id: 'api', top: 520 },
        ],
        160,
      ),
    ).toBe('cli')
  })

  test('counts a section that landed a fraction of a pixel below the read line as reached', () => {
    expect(
      activeSectionId(
        [
          { id: 'powersync', top: -900 },
          { id: 'electric', top: 80.5 },
        ],
        80,
      ),
    ).toBe('electric')
  })

  test('stays on the last block once the page cannot scroll further', () => {
    expect(
      activeSectionId(
        [
          { id: 'honesty', top: -400 },
          { id: 'faq', top: 10 },
        ],
        80,
      ),
    ).toBe('faq')
  })
})

describe('hashForSection', () => {
  test('clears the hash on the hero so the landing URL stays bare', () => {
    expect(hashForSection('home')).toBe('')
  })

  test('emits a fragment for every other home block', () => {
    expect(hashForSection('cli')).toBe('#cli')
    expect(hashForSection('how-it-works')).toBe('#how-it-works')
    expect(hashForSection('features')).toBe('#features')
    expect(hashForSection('faq')).toBe('#faq')
  })

  test('keeps the URL bare on the section another page names instead of the hero', () => {
    expect(hashForSection('intro', 'intro')).toBe('')
    expect(hashForSection('matrix', 'intro')).toBe('#matrix')
    expect(hashForSection('home', 'intro')).toBe('#home')
  })
})

describe('isSamePageHashLink', () => {
  const page = 'https://kizunasync.com/compare'

  test('matches a fragment-only link on the current page', () => {
    expect(isSamePageHashLink('#primary-sources', page)).toBe(true)
  })

  test('matches an absolute or root-relative link to the current path with a fragment', () => {
    expect(isSamePageHashLink('/compare#electric', `${page}#matrix`)).toBe(true)
    expect(isSamePageHashLink('https://kizunasync.com/compare#zero', page)).toBe(true)
  })

  test('ignores a fragment link to another page', () => {
    expect(isSamePageHashLink('/#faq', page)).toBe(false)
    expect(isSamePageHashLink('/docs/comparison-with-alternatives#zero', page)).toBe(false)
  })

  test('ignores another origin that shares the path', () => {
    expect(isSamePageHashLink('https://example.com/compare#zero', page)).toBe(false)
  })

  test('ignores a link without a fragment', () => {
    expect(isSamePageHashLink('/compare', `${page}#matrix`)).toBe(false)
    expect(isSamePageHashLink('#', page)).toBe(false)
  })
})
