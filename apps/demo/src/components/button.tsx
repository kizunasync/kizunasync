import type { ButtonHTMLAttributes, ReactNode } from 'react'

// MARK: - Button

/**
 * The demo's only button. Extracted because the same utility run appears on
 * every control in every pane; a third copy would be the point at which the
 * string starts drifting. Tones are semantic, not decorative: `accent` marks the
 * primary action of its surface, `active` marks a toggle that is currently on.
 */
type TButtonTone = 'default' | 'accent' | 'active'

const BASE_CLASS =
  'shrink-0 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45'

const TONE_CLASS: Record<TButtonTone, string> = {
  default: 'border-site-border bg-site-raised text-site-text hover:not-disabled:border-site-faint',
  accent: 'border-site-accent bg-site-accent text-site-accent-foreground hover:not-disabled:bg-site-accent-bright',
  active: 'border-site-accent bg-site-accent/15 text-site-accent',
}

interface IButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: TButtonTone
  children: ReactNode
}

export function Button({ tone = 'default', children, ...rest }: IButtonProps) {
  return (
    <button className={`${BASE_CLASS} ${TONE_CLASS[tone]}`} {...rest}>
      {children}
    </button>
  )
}
