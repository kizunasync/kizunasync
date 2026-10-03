import { CookieSettingsLink } from '@kizunasync/ui'
import { GITHUB_URL, SITE_FULL_NAME } from '@/lib/site'
import { HeroCommand } from '@/components/hero-command'
import { SITE_FOOTER_COLUMNS } from '@/components/site-footer.data'
import { RevealOnScroll } from '@/components/motion/reveal-on-scroll'

// MARK: - Site footer

export function SiteFooter() {
  return (
    <footer className="bg-site-surface">
      <section className="site-container flex flex-col items-center pt-16 text-center sm:pt-20">
        <RevealOnScroll className="flex w-full flex-col items-center">
          <div className="flex items-center gap-3">
            <span className="text-site-accent font-display text-6xl leading-none" aria-hidden="true">
              絆
            </span>
            <span className="text-site-text text-5xl leading-none font-bold tracking-tight">
              KIZUNA <span className="text-site-muted">sync</span>
            </span>
          </div>
          <h2 className="font-display mt-4 text-2xl font-bold tracking-tight sm:text-3xl">
            Tie the knot between your app and your Supabase.
          </h2>
          <p className="text-site-muted mt-4 text-base">
            Its SQL runs in your project; no Kizuna-operated service receives sync traffic.
          </p>
          <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row">
            <HeroCommand />
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-site-muted hover:text-site-text text-sm underline-offset-4 transition-colors hover:underline"
            >
              Inspect the source →
            </a>
          </div>
        </RevealOnScroll>
      </section>

      <SiteFooterColumns />
      <div className="border-site-border/60 border-t">
        <div className="site-container text-site-faint flex flex-wrap items-center justify-between gap-2 py-5 text-xs">
          <p>
            © {new Date().getFullYear()} Kizuna Sync contributors · Built by{' '}
            <a
              href="https://smartsquad.io"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-site-text transition-colors"
            >
              Smart Squad Srl
            </a>
            <CookieSettingsLink
              gtmId={process.env.NEXT_PUBLIC_WEBSITE_GTM_ID ?? ''}
              className="hover:text-site-text ml-3 transition-colors"
            />
          </p>
          <p className="font-mono">kee-zoo-nah · 絆 · the red thread holds</p>
        </div>
      </div>
    </footer>
  )
}

// MARK: - Pieces

function SiteFooterColumns() {
  return (
    <div>
      <div className="site-container grid gap-10 py-12 sm:grid-cols-[1.2fr_repeat(3,1fr)] sm:py-16">
        <div>
          <p className="flex items-baseline gap-1.5 font-semibold tracking-tight">
            <span className="text-site-accent font-display text-lg leading-none" aria-hidden="true">
              絆
            </span>
            <span>{SITE_FULL_NAME}</span>
          </p>
          <p className="text-site-muted mt-3 max-w-xs text-sm leading-relaxed">
 絆: the bonds that tie people together. Here: the bond between your users&apos;
            devices and their data: local while offline, reconciled after a successful sync.
          </p>
          <p className="text-site-faint mt-4 text-xs">
            Source-only Alpha · Apache-2.0 clients · PolyForm Shield SQL pack
          </p>
        </div>
        {SITE_FOOTER_COLUMNS.map((column) => (
          <SiteFooterColumn key={column.title} column={column} />
        ))}
      </div>
    </div>
  )
}

function SiteFooterColumn({ column }: { column: (typeof SITE_FOOTER_COLUMNS)[number] }) {
  return (
    <nav aria-label={column.title}>
      <p className="text-site-faint font-mono text-xs tracking-wide uppercase">
        {column.title}
      </p>
      <ul className="mt-3 space-y-2 text-sm">
        {column.links.map((link) => (
          <li key={link.label}>
            <a
              href={link.href}
              className="text-site-muted hover:text-site-text transition-colors"
              {...(link.href.startsWith('http')
                ? { target: '_blank', rel: 'noopener noreferrer' }
                : {})}
            >
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
