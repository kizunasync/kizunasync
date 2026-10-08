import { RevealOnScroll } from '@/components/motion/reveal-on-scroll'
import { CompareResearchDate } from '@/components/compare/compare-research-date'
import { COMPARE_PRODUCTS, productSources } from '@/components/compare/compare-matrix.data'

const withoutFragment = (url: string): string => url.split('#')[0]!

const SOURCED_PRODUCTS = COMPARE_PRODUCTS.map((product) => ({ name: product.name, sources: [...new Set(productSources(product.id).map(withoutFragment))] })).filter(
  (product) => product.sources.length > 0,
)

function formatSourceLabel(url: string): string {
  const { host, pathname } = new URL(url)

  return `${host}${pathname}`.replace(/\/$/, '')
}

export function ComparePrimarySources() {
  return (
    <section id="primary-sources" className="mt-16 scroll-mt-20">
      <RevealOnScroll>
        <p className="text-site-accent font-mono text-xs tracking-wide uppercase">Primary sources</p>
        <h2 className="font-display mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
          Read the official pages behind the matrix.
        </h2>
        <p className="text-site-muted mt-2 max-w-2xl">
          The matrix cells of the other products link these pages, as read on <CompareResearchDate />. Each
          vendor can change its pages at any time, which is why the page carries that date.
        </p>
      </RevealOnScroll>
      <RevealOnScroll staggerChildren className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SOURCED_PRODUCTS.map((product) => (
          <div key={product.name} className="border-site-border bg-site-surface/50 rounded-xl border p-5">
            <p className="font-semibold">{product.name}</p>
            <ul className="mt-1.5 space-y-1 text-sm leading-relaxed">
              {product.sources.map((url) => (
                <li key={url}>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-site-muted hover:text-site-accent wrap-anywhere transition-colors"
                  >
                    {formatSourceLabel(url)}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </RevealOnScroll>
      <RevealOnScroll className="mt-6">
        <p className="text-site-faint text-xs leading-relaxed">
          All trademarks belong to their respective owners, and no endorsement is implied. Some
          apps need a different kind of tool: concurrent text or canvas editing needs a{' '}
          <a
            href="https://grokipedia.com/page/Conflict-free_replicated_data_type"
            target="_blank"
            rel="noopener noreferrer"
            className="text-site-accent hover:underline"
          >
            CRDT
          </a>{' '}
          system, a transactional invariant across users needs an online-only flow, and sync
          between devices with no server in the middle needs a peer-to-peer system, because Kizuna
          routes every change through your Supabase project (
          <a href="/docs/design-tradeoffs" className="text-site-accent hover:underline">
            Design trade-offs
          </a>
          ).{' '}
          <a href="/docs/introduction" className="text-site-accent hover:underline">
            Product &amp; fit
          </a>{' '}
          lists the cases where Kizuna is the wrong tool.
        </p>
      </RevealOnScroll>
    </section>
  )
}
