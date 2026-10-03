import Link from 'next/link'

// MARK: - DocCard

export function DocCard({
  href,
  title,
  description,
  meta,
}: {
  href: string
  title: string
  description: string
  meta?: string
}) {
  return (
    <Link
      href={href}
      className="border-site-border bg-site-surface/50 hover:border-site-accent-dim block rounded-xl border p-5 transition-[border-color,transform] duration-200 hover:-translate-y-0.5"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold">{title}</h3>
        {meta !== undefined ? (
          <span className="text-site-faint shrink-0 font-mono text-[10px] tracking-wide uppercase">
            {meta}
          </span>
        ) : null}
      </div>
      <p className="text-site-muted mt-1.5 text-sm leading-relaxed">{description}</p>
    </Link>
  )
}
