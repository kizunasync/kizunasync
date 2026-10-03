import type { TPaneId } from '@/runtime/demo-config'

// MARK: - Pane tag

/**
 * The A/B badge. One colour per pane, used identically on the pane header and on
 * every wire-log row, so a reader can trace a line back to its pane by colour
 * alone rather than by reading the letter.
 */
const TONE_CLASS: Record<TPaneId, string> = {
  A: 'bg-site-accent text-site-accent-foreground',
  B: 'bg-site-gold text-site-background',
}

export function PaneTag({ pane }: { pane: TPaneId }) {
  return (
    <span
      className={`inline-grid size-5.5 shrink-0 place-items-center rounded-md text-xs font-extrabold ${TONE_CLASS[pane]}`}
    >
      {pane}
    </span>
  )
}
