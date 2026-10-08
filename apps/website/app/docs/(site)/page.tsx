import type { Metadata } from 'next'
import { DOC_GROUPS, DOCS, docsForNav } from '@/lib/docs-registry'
import { REFERENCE_LIBRARIES, referenceHref } from '@/lib/reference-registry'
import { DocCard } from '@/components/doc-card'
import { pageMetadata } from '@/lib/page-metadata'

export const metadata: Metadata = pageMetadata({
  title: 'Docs',
  description: 'Kizuna Sync documentation: getting started, sync, attachments, CLI, operations, API reference, and resources.',
  path: '/docs',
})

const FEATURED = ['introduction', 'quickstart', 'playground'] as const

const FRAMEWORKS = [
  { slug: 'react', title: 'React' },
  { slug: 'vue', title: 'Vue' },
  { slug: 'expo', title: 'Expo / React Native' },
  { slug: 'native-clients', title: 'Swift and Kotlin' },
  { slug: 'vite', title: 'Vite' },
  { slug: 'vanilla-js', title: 'Vanilla' },
] as const

function docBySlug(slug: string) {
  return DOCS.find((doc) => doc.slug === slug)
}

// MARK: - Docs index

export default function DocsIndexPage() {
  const featured = FEATURED.map((slug) => docBySlug(slug)).filter((doc) => doc !== undefined)

  return (
    <main id="main-content">
      <p className="text-site-accent font-mono text-xs tracking-wide uppercase">Documentation</p>
      <h1 className="font-display mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
        Get up and running with Kizuna
      </h1>
      <p className="text-site-muted mt-4 max-w-2xl leading-relaxed">
        Offline-first sync for the Supabase project you own. Start with the introduction, run{' '}
        <code className="font-mono text-xs">kizunasync</code> in your app project, or open the playground.
      </p>

      <section className="mt-10">
        <h2 className="text-site-faint font-mono text-xs tracking-wide uppercase">Getting started</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          {featured.map((doc) => (
            <DocCard
              key={doc.slug}
              href={`/docs/${doc.slug}`}
              title={doc.title}
              description={doc.description}
            />
          ))}
        </div>
      </section>

      <DocsFrameworkSection />

      <section className="mt-12">
        <h2 className="text-site-faint font-mono text-xs tracking-wide uppercase">Client library reference</h2>
        <p className="text-site-muted mt-2 max-w-2xl text-sm leading-relaxed">
 Supabase-style API reference for each client library: methods, guides, and types rendered in-site.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {REFERENCE_LIBRARIES.map((library) => (
            <DocCard
              key={library.id}
              href={referenceHref(library.id, 'introduction')}
              title={library.title}
              description={library.description}
              meta="Alpha"
            />
          ))}
        </div>
      </section>

      <div className="mt-12 space-y-10">
        {DOC_GROUPS.filter((group) => group !== 'Getting started').map((group) => (
          <section key={group}>
            <h2 className="text-site-faint font-mono text-xs tracking-wide uppercase">{group}</h2>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              {docsForNav(DOCS.filter((doc) => doc.group === group)).map((doc) => (
                <DocCard
                  key={doc.slug}
                  href={`/docs/${doc.slug}`}
                  title={doc.title}
                  description={doc.description}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  )
}

function DocsFrameworkSection() {
  return (
    <section className="mt-12">
      <h2 className="text-site-faint font-mono text-xs tracking-wide uppercase">Connect a framework</h2>
      <p className="text-site-muted mt-2 max-w-2xl text-sm leading-relaxed">
        Start with a how-to for the UI you already ship. Dedicated bindings are React and Vue; Swift and Kotlin use <code className="font-mono text-xs">KizunaSyncClient</code>; every other JavaScript UI uses the core client.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FRAMEWORKS.map((item) => {
          const doc = docBySlug(item.slug)

          if (doc === undefined) {
            return null
          }
          return (
            <DocCard
              key={item.slug}
              href={`/docs/${item.slug}`}
              title={item.title}
              description={doc.description}
            />
          )
        })}
      </div>
    </section>
  )
}
