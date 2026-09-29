import type { ReactNode } from 'react'
import { Button } from '@heroui/react'

// MARK: - Segment pill group

/**
 * HeroUI's ButtonGroup joins adjacent buttons into one rounded capsule: it
 * strips each button's own radius and shares borders between neighbors. A
 * segmented control (nav tabs, status filters, log filters) instead reads as
 * a row of independent full-radius pills, exactly like the account chips
 * (standalone outline Buttons). This renders each option as its own HeroUI
 * Button in a flex/gap row rather than routing through ButtonGroup.
 */
export function SegmentPillGroup({
  ariaLabel,
  grow,
  children,
}: {
  ariaLabel: string
  grow?: boolean
  children: ReactNode
}) {
  return (
    <div className={grow === true ? 'segment-pill-group is-grow' : 'segment-pill-group'} role="group" aria-label={ariaLabel}>
      {children}
    </div>
  )
}

export function SegmentPill({
  isActive,
  onPress,
  children,
}: {
  isActive: boolean
  onPress: () => void
  children: ReactNode
}) {
  return (
    <Button size="sm" variant={isActive ? 'primary' : 'outline'} aria-pressed={isActive} onPress={onPress}>
      {children}
    </Button>
  )
}
