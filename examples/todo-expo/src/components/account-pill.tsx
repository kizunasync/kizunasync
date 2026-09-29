import { Chip } from 'heroui-native'

/**
 * One account chip in the switcher row. Disabled while offline: an account
 * switch wipes the local database and needs a sync, so it is refused there.
 *
 * heroui's Chip is this control: a capsule taking press props with a selected
 * and an unselected variant, so the pill is the library's rather than a
 * hand-rolled Pressable. Its press feedback is the library's own, and
 * `accent` resolves to vermilion through global.css.
 */
export function AccountPill({
  label,
  active,
  disabled,
  onPress,
}: {
  label: string
  active: boolean
  disabled: boolean
  onPress: () => void
}) {
  return (
    <Chip
      variant={active ? 'primary' : 'tertiary'}
      color="accent"
      size="sm"
      disabled={disabled}
      onPress={onPress}
      className={active ? 'border border-accent' : 'border border-border'}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled }}
    >
      <Chip.Label className={active ? undefined : 'text-muted'}>{label}</Chip.Label>
    </Chip>
  )
}
