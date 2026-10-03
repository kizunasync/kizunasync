import Link from 'next/link'

// MARK: - DocPageFooter

export function DocPageFooter({
  prev,
  next,
  editUrl,
}: {
  prev: { href: string; title: string } | null
  next: { href: string; title: string } | null
  editUrl: string
}) {
  return (
    <>
      <div className="border-site-border/60 mt-12 flex flex-wrap items-center justify-between gap-4 border-t pt-6 text-sm">
        {prev !== null ? (
          <Link href={prev.href} className="text-site-muted hover:text-site-text transition-colors">
            ← {prev.title}
          </Link>
        ) : (
          <span />
        )}
        {next !== null ? (
          <Link href={next.href} className="text-site-muted hover:text-site-text transition-colors">
            {next.title} →
          </Link>
        ) : (
          <span />
        )}
      </div>
      <p className="text-site-faint mt-6 text-xs">
        Found a problem?{' '}
        <a
          href={editUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-site-accent hover:underline"
        >
          Edit this page on GitHub
        </a>
      </p>
    </>
  )
}
