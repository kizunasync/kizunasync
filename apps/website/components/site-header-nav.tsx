import Link from 'next/link'
import { NAV, TRY_DEMO } from '@/components/site-header.data'
import { GITHUB_URL } from '@/lib/site'

/** Desktop nav row: page links, the Try demo CTA, and the GitHub link. */
export function SiteHeaderNav() {
  return (
    <nav aria-label="Main" className="hidden items-center gap-1 sm:gap-2 md:flex">
      {NAV.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className="text-site-muted hover:text-site-text rounded-md px-2.5 py-1.5 text-sm transition-colors"
        >
          {item.label}
        </Link>
      ))}
      <a
        href={TRY_DEMO.href}
        target="_blank"
        rel="noopener noreferrer"
        className="bg-site-accent text-site-accent-foreground hover:bg-site-accent-bright ml-1 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors"
      >
        {TRY_DEMO.label}
      </a>
      <a
        href={GITHUB_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="border-site-border hover:border-site-accent-dim ml-1 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors"
      >
        GitHub
      </a>
    </nav>
  )
}
