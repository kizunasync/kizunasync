import { ICONS, type TIconName } from '@kizunasync/ui'

// MARK: - Icon

/**
 * Every glyph in the inspector comes from the shared Nerd Font catalog through
 * this one component, so no file hand-types a codepoint escape. Always
 * decorative: the meaning lives in the label beside it, never in the glyph,
 * which no screen reader can pronounce.
 */
export function Icon({ name, className }: { name: TIconName; className?: string }) {
  return (
    <span className={className === undefined ? 'nf' : `nf ${className}`} aria-hidden="true">
      {ICONS[name]}
    </span>
  )
}
