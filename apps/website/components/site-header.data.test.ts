import { describe, expect, test } from 'bun:test'
import { MOBILE_NAV, NAV } from '@/components/site-header.data'

describe('site header nav', () => {
  test('links Compare right after Features', () => {
    const features = NAV.findIndex((item) => item.label === 'Features')

    expect(NAV[features + 1]).toEqual({ href: '/compare', label: 'Compare' })
  })

  test('shows Compare in the mobile menu too', () => {
    expect(MOBILE_NAV).toContainEqual({ href: '/compare', label: 'Compare' })
  })
})
