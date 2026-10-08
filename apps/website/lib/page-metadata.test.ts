import { describe, expect, test } from 'bun:test'
import { pageMetadata } from '@/lib/page-metadata'
import { SHARE_IMAGE_ALT, SITE_FULL_NAME } from '@/lib/site'

describe('pageMetadata', () => {
  const input = { title: 'Feedback', description: 'Send feedback.', path: '/feedback' }
  const metadata = pageMetadata(input)

  test('sets the page title, description, and its own canonical path', () => {
    expect(metadata.title).toBe('Feedback')
    expect(metadata.description).toBe('Send feedback.')
    expect(metadata.alternates).toEqual({ canonical: '/feedback' })
  })

  test('gives Open Graph the page url, title, and description under the site name, with the root share image as fallback', () => {
    expect(metadata.openGraph).toEqual({
      type: 'website',
      siteName: SITE_FULL_NAME,
      title: 'Feedback',
      description: 'Send feedback.',
      url: '/feedback',
      images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: SHARE_IMAGE_ALT }],
    })
  })

  test('leaves the Open Graph images unset for a route with its own image file', () => {
    const own = pageMetadata({ ...input, title: 'Compare', path: '/compare', hasOwnImage: true })

    expect(own.openGraph).toEqual({ type: 'website', siteName: SITE_FULL_NAME, title: 'Compare', description: 'Send feedback.', url: '/compare' })
    expect(own.openGraph !== null && own.openGraph !== undefined && 'images' in own.openGraph).toBe(false)
  })

  test('gives the Twitter card the same title and description and no image of its own', () => {
    expect(metadata.twitter).toEqual({ card: 'summary_large_image', title: 'Feedback', description: 'Send feedback.' })
  })
})
