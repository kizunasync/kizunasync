import type { Metadata } from 'next'
import Link from 'next/link'
import { REFERENCE_LIBRARIES, referenceHref } from '@/lib/reference-registry'
import { readLibraryVersion } from '@/lib/docs'
import { DocCard } from '@/components/doc-card'
import { DocEyebrow } from '@/components/doc-eyebrow'

export const metadata: Metadata = {
  title: 'Client library reference · Docs',
  description:
    'Supabase-style API reference for Swift, Kotlin, JavaScript, React, Vue, and Expo client libraries.',
}

// MARK: - Client library reference hub

export default function ReferenceHubPage() {
  return (
    <main id="main-content" className="min-w-0">
      <DocEyebrow crumbs={[{ href: '/docs', label: 'Docs' }, { label: 'Client library reference' }]} />
      <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
        Client library reference
      </h1>
      <p className="text-site-muted mt-4 max-w-2xl leading-relaxed">
 Method-by-method reference for each Kizuna client, the same shape as Supabase&apos;s client docs, rendered from the repository markdown under <code className="font-mono text-xs">docs/reference/</code>.
      </p>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        {REFERENCE_LIBRARIES.map((library) => (
          <DocCard
            key={library.id}
            href={referenceHref(library.id, 'introduction')}
            title={library.title}
            description={library.description}
            meta={`v${readLibraryVersion(library.versionSource)} · Alpha`}
          />
        ))}
      </div>

      <p className="text-site-muted mt-10 text-sm">
        Prefer the narrative guides?{' '}
        <Link href="/docs" className="text-site-accent hover:underline">
          Return to the docs index
        </Link>
        .
      </p>
    </main>
  )
}
