import { describe, expect, test } from 'bun:test'
import { faqJsonLd, HOME_FAQ_IDS, homeFaq, jsonLdScript, parseFaq, readFaq } from '@/lib/faq'

const sample = ['## Offline', '', '### What happens offline?', '', 'Writes wait in the outbox. See [Offline writes](../sync/offline-writes.md).', '', '## Related pages', '', '- [Glossary](./glossary.md)'].join('\n')

describe('faq', () => {
  test('parses themes, questions, and answers, and ignores the closing section', () => {
    const [entry, ...rest] = parseFaq(sample)

    expect(rest).toHaveLength(0)
    expect(entry).toEqual({ id: 'what-happens-offline', theme: 'Offline', question: 'What happens offline?', answerMarkdown: 'Writes wait in the outbox. See [Offline writes](../sync/offline-writes.md).', answerText: 'Writes wait in the outbox. See Offline writes.' })
  })

  test('the docs FAQ has 24 questions', () => {
    expect(readFaq()).toHaveLength(24)
  })

  test('every home question exists in the docs FAQ', () => {
    const ids = new Set(readFaq().map((entry) => entry.id))

    for (const id of HOME_FAQ_IDS) {
      expect(ids.has(id)).toBe(true)
    }
  })

  test('homeFaq returns the home questions in order', () => {
    expect(homeFaq().map((entry) => entry.id)).toEqual([...HOME_FAQ_IDS])
  })

  test('builds FAQPage structured data', () => {
    const jsonLd = faqJsonLd(parseFaq(sample))

    expect(jsonLd['@type']).toBe('FAQPage')
    expect(JSON.stringify(jsonLd)).toContain('What happens offline?')
  })

  test('escapes < in serialized JSON-LD so an answer cannot close the script tag', () => {
    const [entry] = parseFaq('## Theme\n\n### Q?\n\nAnswer with `</script>` inside.')
    const script = jsonLdScript(faqJsonLd(entry === undefined ? [] : [entry]))

    expect(script).not.toContain('<')
    expect(script).toContain('\\u003c/script>')
    expect(JSON.parse(script).mainEntity[0].acceptedAnswer.text).toContain('</script>')
  })
})
