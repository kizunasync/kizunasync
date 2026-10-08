import { getDoc } from './docs'
import { markdownSections } from './markdown-sections'

// MARK: - FAQ

export interface IFaqEntry {
  id: string
  theme: string
  question: string
  answerMarkdown: string
  answerText: string
}

interface IFaqPage {
  '@type': 'FAQPage'
  mainEntity: unknown[]
}

/** Questions shown on the home page, in display order. */
export const HOME_FAQ_IDS: readonly string[] = [
  'what-happens-when-a-device-stays-offline-for-a-very-long-time',
  'does-kizuna-work-with-the-supabase-js-client-or-instead-of-it',
  'how-does-kizuna-sync-large-files',
  'how-is-kizuna-different-from-powersync-electric-firestore-and-the-others',
  'how-are-conflicts-handled',
  'what-does-kizuna-cost-to-run',
]

export function parseFaq(markdown: string): IFaqEntry[] {
  return markdownSections(markdown, 3).map((section) => ({
    id: section.id,
    theme: section.parentHeading ?? '',
    question: section.heading,
    answerMarkdown: section.bodyMarkdown,
    answerText: section.bodyText,
  }))
}

/** The docs FAQ page from the registry; server-only (reads the repository file). */
export function faqDoc(): NonNullable<ReturnType<typeof getDoc>> {
  const doc = getDoc('faq')

  if (doc === null) {
    throw new Error('The docs registry has no "faq" page')
  }
  return doc
}

export function readFaq(): IFaqEntry[] {
  return parseFaq(faqDoc().content)
}

export function homeFaq(): IFaqEntry[] {
  const entries = readFaq()

  return HOME_FAQ_IDS.map((id) => {
    const entry = entries.find((candidate) => candidate.id === id)

    if (entry === undefined) {
      throw new Error(`Home FAQ id "${id}" is missing from the docs FAQ page`)
    }
    return entry
  })
}

export function faqJsonLd(entries: IFaqEntry[]): IFaqPage {
  return {
    '@type': 'FAQPage',
    mainEntity: entries.map((entry) => ({
      '@type': 'Question',
      name: entry.question,
      acceptedAnswer: { '@type': 'Answer', text: entry.answerText },
    })),
  }
}

/** Serializes JSON-LD for an inline script; `<` is escaped so page text can never close the tag. */
export function jsonLdScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}
