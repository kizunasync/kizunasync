import { COMPARE_DESCRIPTION, COMPARE_TITLE } from '@/lib/compare-copy'
import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from '@/lib/og-image'

export const alt = 'Kizuna Sync compared with other sync libraries for Supabase'
export const size = OG_SIZE
export const contentType = OG_CONTENT_TYPE

export default function Image() {
  return renderOgImage({ eyebrow: 'Compare', title: COMPARE_TITLE, description: COMPARE_DESCRIPTION })
}
