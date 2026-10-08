import { DEMO_URL, GITHUB_URL } from '@/lib/site'

export const NAV = [
  { href: '/#how-it-works', label: 'How it works' },
  { href: '/#features', label: 'Features' },
  { href: '/compare', label: 'Compare' },
  { href: '/docs', label: 'Docs' },
  { href: '/docs/contribute', label: 'Contribute' },
] as const

export const TRY_DEMO = { href: DEMO_URL, label: 'Try demo' } as const
export const MOBILE_NAV = [...NAV, TRY_DEMO, { href: GITHUB_URL, label: 'GitHub' }] as const
