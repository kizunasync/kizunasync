import { COMPARE_RESEARCHED_AT } from '@/components/compare/compare-matrix.data'

const RESEARCH_DATE_LABEL = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(COMPARE_RESEARCHED_AT))

export function CompareResearchDate() {
  return <time dateTime={COMPARE_RESEARCHED_AT}>{RESEARCH_DATE_LABEL}</time>
}
