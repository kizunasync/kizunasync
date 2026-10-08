import { OG_CONTENT_TYPE, OG_SIZE, renderHomeOgImage } from '@/lib/og-image'
import { SHARE_IMAGE_ALT } from '@/lib/site'

export const alt = SHARE_IMAGE_ALT
export const size = OG_SIZE
export const contentType = OG_CONTENT_TYPE

export default function Image() {
  return renderHomeOgImage()
}
