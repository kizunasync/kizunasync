import type { ReactNode } from 'react'

// MARK: - Status pill

export type TPillTone = 'ok' | 'muted' | 'accent' | 'gold' | 'danger'

const TONE_CLASS: Record<TPillTone, string> = {
  ok: 'border-site-ok/30 bg-site-ok/10 text-site-ok',
  muted: 'border-site-border/70 bg-site-raised/30 text-site-muted',
  accent: 'border-site-accent/30 bg-site-accent/10 text-site-accent-bright',
  gold: 'border-site-gold/30 bg-site-gold/10 text-site-gold',
  danger: 'border-site-danger/30 bg-site-danger/10 text-site-danger',
}

/**
 * The one tinted hairline chip every panel tags state with: tables and the
 * changelog log alike, so a tone means the same thing everywhere.
 */
export function StatusPill({ children, tone = 'muted' }: { children: ReactNode; tone?: TPillTone }) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[0.68rem] leading-none tracking-wide ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  )
}
