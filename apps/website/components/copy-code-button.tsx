'use client'

import { useCopyToClipboard } from '@/lib/use-copy-to-clipboard'

// MARK: - CopyCodeButton

/**
 * Hover-visible copy affordance for a fenced code block; mirrors the ⧉/✓
 * glyph pair HeroCommand already uses for the same clipboard interaction.
 */
export function CopyCodeButton({ code }: { code: string }) {
  const { copied, copy } = useCopyToClipboard()

  return (
    <button
      type="button"
      onClick={() => void copy(code)}
      aria-label="Copy code"
      className="border-site-border bg-site-surface/80 text-site-faint hover:text-site-text absolute top-2.5 right-2.5 rounded-md border p-1.5 font-mono text-xs opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
    >
      <span aria-hidden="true">{copied ? '✓' : '⧉'}</span>
    </button>
  )
}
