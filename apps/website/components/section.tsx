/**
 * Landing-page section shell: single source of truth for the repeated
 * `<section><div class="site-container py-16 sm:py-20">` pattern. Width comes
 * from the site-container utility (globals.css); this owns the vertical rhythm,
 * the top divider and the scroll-margin anchor offset. Server component; colors
 * via theme tokens only. The hero, stats strip and bottom CTA are bespoke and
 * stay hand-written.
 */

// MARK: - Section

import type { ReactNode } from 'react'

function cx(...parts: (string | false | undefined)[]) {
  return parts.filter(Boolean).join(' ')
}

export function Section({
  id,
  bordered = true,
  className,
  containerClassName,
  children,
}: {
  id?: string
  bordered?: boolean
  className?: string
  containerClassName?: string
  children: ReactNode
}) {
  return (
    <section
      id={id}
      className={cx(
        'scroll-mt-20',
        bordered && 'border-site-border/60 border-t',
        className,
      )}
    >
      <div className={cx('site-container py-16 sm:py-20', containerClassName)}>{children}</div>
    </section>
  )
}
