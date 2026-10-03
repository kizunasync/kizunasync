import Link from 'next/link'

// MARK: - DocEyebrow

export function DocEyebrow({
  crumbs,
  meta,
}: {
  crumbs: Array<{ href?: string; label: string }>
  meta?: string
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <p className="text-site-faint font-mono text-xs tracking-wide uppercase">
        {crumbs.map((crumb, index) => (
          <span key={`${crumb.label}-${index}`}>
            {index > 0 ? (
              <>
                {' '}
                <span aria-hidden="true">/</span>{' '}
              </>
            ) : null}
            {crumb.href !== undefined ? (
              <Link href={crumb.href} className="hover:text-site-text transition-colors">
                {crumb.label}
              </Link>
            ) : (
              crumb.label
            )}
          </span>
        ))}
      </p>
      {meta !== undefined ? (
        <span className="text-site-faint font-mono text-xs tracking-wide">{meta}</span>
      ) : null}
    </div>
  )
}
