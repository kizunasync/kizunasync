import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { RADIUS, SPACING } from '@kizunasync/ui'
import { formatClockTime } from '@kizunasync/utilities'
import { EThemeColor } from '../theme'
import { GlassSurface, IS_GLASS_AVAILABLE } from './glass-surface'
import { ToggleSwitch } from './toggle-switch'
import { t } from '../i18n'

/**
 * Connection strip: the online/offline dot (tapping the bar toggles simulated
 * offline), the queued-write count, when the last sync cycle resolved, and
 * the manual sync button. `syncing` is the caller's in-flight cycle: the
 * button says so and refuses a second tap until that cycle resolves.
 *
 * The whole bar is pressable (it toggles simulated offline). A DISABLED
 * Pressable declines the touch responder; it does not swallow it. Without
 * the wrapper below, tapping the greyed sync button would fall through and
 * flip the app offline. The wrapper claims the touch while syncing, matching
 * what react-native-web already does for a disabled button on its own target.
 */
export function SyncBar({
  offline,
  outboxDepth,
  note,
  lastSyncAt,
  syncing,
  onSync,
  onToggleOffline,
}: {
  offline: boolean
  outboxDepth: number
  note: string | null
  lastSyncAt: number | null
  syncing: boolean
  onSync: () => void
  onToggleOffline: () => void
}) {
  return (
    <Pressable
      style={[styles.syncBar, IS_GLASS_AVAILABLE ? styles.syncBarGlassHost : null]}
      onPress={onToggleOffline}
    >
      <GlassSurface style={styles.syncBarGlass} />
      <View style={[styles.dot, { backgroundColor: offline ? EThemeColor.accent : EThemeColor.success }]} />
      <View style={styles.syncTextWrap}>
        <Text style={styles.syncStatus}>
          {offline ? t('sync.offline') : t('sync.online')}
          <Text style={styles.syncOutbox}>{`  ·  ${t('sync.outbox', { count: outboxDepth })}`}</Text>
        </Text>
        <Text style={styles.syncMeta}>
          {lastSyncAt === null ? 'Not synced yet' : `Last sync ${formatClockTime(lastSyncAt)}`}
        </Text>
        {note !== null ? (
          <Text style={styles.syncNote} numberOfLines={1}>
            {note}
          </Text>
        ) : null}
      </View>
      <SyncButton syncing={syncing} onSync={onSync} />
      <ToggleSwitch value={!offline} />
    </Pressable>
  )
}

// MARK: - Pieces

/**
 * The manual "sync now" button: its own hover state, and the busy style while
 * `syncing` holds. The wrapping View claims the touch responder while
 * syncing, so a tap on the disabled button never falls through to the bar's
 * own onPress (see the file doc comment).
 */
function SyncButton({ syncing, onSync }: { syncing: boolean; onSync: () => void }) {
  const [hovered, setHovered] = useState(false)

  return (
    <View onStartShouldSetResponder={() => syncing}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: syncing }}
        disabled={syncing}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={onSync}
        style={[styles.syncButton, hovered && !syncing && styles.syncButtonHover, syncing && styles.syncButtonBusy]}
      >
        <Text style={[styles.syncButtonText, syncing && styles.syncButtonBusyText]}>
          {syncing ? t('sync.syncing') : t('sync.now')}
        </Text>
      </Pressable>
    </View>
  )
}

// MARK: - internal

const SYNC_BAR_RADIUS = RADIUS.xl
/**
 * The glass layer must cover the bar's whole box, but an absolutely-positioned
 * child is laid out against the parent's PADDING box, so it bleeds outward by
 * exactly the bar's padding and the host clips it back with overflow: 'hidden'.
 * That pairing is correct whichever edge the layout engine measures from.
 */
const SYNC_BAR_PADDING = SPACING[3]

const styles = StyleSheet.create({
  syncBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: SYNC_BAR_PADDING,
    borderRadius: SYNC_BAR_RADIUS,
    backgroundColor: EThemeColor.surface,
    borderWidth: 1,
    borderColor: EThemeColor.hairline,
  },
  syncBarGlassHost: { backgroundColor: 'transparent', overflow: 'hidden' },
  syncBarGlass: {
    position: 'absolute',
    top: -SYNC_BAR_PADDING,
    left: -SYNC_BAR_PADDING,
    right: -SYNC_BAR_PADDING,
    bottom: -SYNC_BAR_PADDING,
    borderRadius: SYNC_BAR_RADIUS,
  },
  dot: { width: 9, height: 9, borderRadius: 5 },
  syncTextWrap: { flex: 1, gap: 1 },
  syncStatus: { color: EThemeColor.text, fontSize: 12, fontWeight: '600' },
  syncOutbox: { color: EThemeColor.muted, fontWeight: '500' },
  syncMeta: { color: EThemeColor.muted, fontSize: 11 },
  syncNote: { color: EThemeColor.muted, fontSize: 11 },
  syncButton: {
    borderWidth: 1,
    borderColor: EThemeColor.border,
    backgroundColor: 'transparent',
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: 9,
  },
  syncButtonHover: {
    borderColor: EThemeColor.accent,
    backgroundColor: EThemeColor.accentSoft,
  },
  syncButtonBusy: { borderColor: EThemeColor.hairline, backgroundColor: EThemeColor.surfaceElevated },
  syncButtonText: { color: EThemeColor.muted, fontSize: 12, fontWeight: '700' },
  syncButtonBusyText: { color: EThemeColor.faint },
})
