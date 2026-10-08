'use client'

import { useSectionHash } from '@/lib/use-section-hash'

export function SectionHashSpy({ bareSectionId }: { bareSectionId?: string }) {
  useSectionHash({ bareSectionId })

  return null
}
