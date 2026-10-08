import type { Metadata } from 'next'
import { OG_SIZE } from './og-image'
import { SHARE_IMAGE_ALT, SITE_FULL_NAME } from './site'

interface IPageMetadataInput {
  title: string
  description: string
  path: string

  /** Next applies a route's opengraph-image file only when that segment's config sets no `openGraph.images`, so a route with its own file must not get the fallback. */
  hasOwnImage?: boolean
}

const ROOT_SHARE_IMAGE = { url: '/opengraph-image', ...OG_SIZE, alt: SHARE_IMAGE_ALT }

/** Per-page canonical URL, Open Graph, and Twitter card, so no page inherits the home page's URL or copy from the root layout. */
export function pageMetadata({ title, description, path, hasOwnImage }: IPageMetadataInput): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: 'website',
      siteName: SITE_FULL_NAME,
      title,
      description,
      url: path,
      ...(hasOwnImage === true ? {} : { images: [ROOT_SHARE_IMAGE] }),
    },
    twitter: { card: 'summary_large_image', title, description },
  }
}
