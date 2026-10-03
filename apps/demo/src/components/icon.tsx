import { ICONS, type TIconName } from '@kizunasync/ui/icons'

// MARK: - Icon

/**
 * Every glyph in the demo comes from the shared Nerd Font catalog through this
 * one component, so no file hand-types a codepoint escape. Always decorative:
 * an icon-only control carries its meaning in the parent's aria-label, never in
 * the glyph, which no screen reader can pronounce.
 */
export function Icon({ name, className }: { name: TIconName; className?: string }) {
  return (
    <span className={className === undefined ? 'nf' : `nf ${className}`} aria-hidden="true">
      {ICONS[name]}
    </span>
  )
}
