import { StyleSheet, Text, View } from 'react-native'
import { RADIUS, SPACING } from '@kizunasync/ui'
import { formatRelativeTime, summarizeEngineEvent } from '@kizunasync/utilities'
import { EThemeColor } from '../../theme'
import type { TEngineEventLogEntry } from '../../engine-events'

/** One engine-event row on the web Cache screen (the shell's fire-and-forget ring). */
export function CacheEventRow({ entry }: { entry: TEngineEventLogEntry }) {
  return (
    <View style={styles.eventRow}>
      <Text style={styles.eventType}>{entry.event.type}</Text>
      <Text style={styles.eventSummary} numberOfLines={1}>
        {summarizeEngineEvent(entry.event)}
      </Text>
      <Text style={styles.eventTime}>{formatRelativeTime(entry.at)}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING[2],
    minWidth: 0,
    backgroundColor: EThemeColor.surface,
    borderWidth: 1,
    borderColor: EThemeColor.hairline,
    borderRadius: 10,
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  eventType: {
    color: EThemeColor.info,
    fontSize: 10,
    fontWeight: '700',
    borderWidth: 1,
    borderColor: EThemeColor.border,
    borderRadius: RADIUS.md,
    paddingHorizontal: 7,
    paddingVertical: 2,
    flexShrink: 0,
    overflow: 'hidden',
  },
  eventSummary: { color: EThemeColor.muted, fontSize: 11, flex: 1, flexShrink: 1, minWidth: 0 },
  eventTime: { color: EThemeColor.muted, fontSize: 11, flexShrink: 0 },
})
