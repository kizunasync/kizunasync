import { StyleSheet, Text, View } from 'react-native'
import { SPACING } from '@kizunasync/ui'
import { EThemeColor } from '../../theme'
import { sharedStyles } from '../../shared-styles'
import { AccountPill } from '../account-pill'
import { OverwritesChip } from '../overwrites'
import { RejectionsChip } from '../rejections'
import { SyncBar } from '../sync-bar'
import { ACCOUNTS, type TAccountKey } from '../../lib/account'
import { t } from '../../i18n'

/**
 * The home header's "Users" region: the rejections/overwrites chips, the
 * account switcher, the share note, and the connection strip. One region per
 * `home-header.tsx` (@CONVENTIONS.md).
 */
export function UsersSection({
  rejectionsCount,
  onOpenRejections,
  overwritesCount,
  onOpenOverwrites,
  account,
  offline,
  onRequestSwitch,
  outboxDepth,
  note,
  lastSyncAt,
  syncing,
  onSync,
  onToggleOffline,
}: {
  rejectionsCount: number
  onOpenRejections: () => void
  overwritesCount: number
  onOpenOverwrites: () => void
  account: TAccountKey
  offline: boolean
  onRequestSwitch: (key: TAccountKey) => void
  outboxDepth: number
  note: string | null
  lastSyncAt: number | null
  syncing: boolean
  onSync: () => void
  onToggleOffline: () => void
}) {
  return (
    <View style={sharedStyles.sectionBlock}>
      <View style={styles.headerTopRow}>
        <Text style={sharedStyles.sectionTitle}>Users</Text>
        <View style={styles.headerChips}>
          <RejectionsChip count={rejectionsCount} onPress={onOpenRejections} />
          <OverwritesChip count={overwritesCount} onPress={onOpenOverwrites} />
        </View>
      </View>
      <View style={styles.accountRow}>
        {ACCOUNTS.map((candidate) => (
          <AccountPill
            key={candidate.key}
            label={candidate.label}
            active={account === candidate.key}
            disabled={offline}
            onPress={() => onRequestSwitch(candidate.key)}
          />
        ))}
      </View>

      <View style={styles.shareStrip}>
        <Text style={styles.shareNote}>{t('share.note')}</Text>
      </View>

      <Text style={sharedStyles.sectionTitle}>Connection</Text>
      <SyncBar
        offline={offline}
        outboxDepth={outboxDepth}
        note={note}
        lastSyncAt={lastSyncAt}
        syncing={syncing}
        onSync={onSync}
        onToggleOffline={onToggleOffline}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  headerTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING[2] },
  headerChips: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  accountRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },

  shareStrip: {
    backgroundColor: EThemeColor.panel,
    borderWidth: 1,
    borderColor: EThemeColor.hairline,
    borderRadius: 10,
    paddingHorizontal: SPACING[3],
    paddingVertical: 9,
  },
  shareNote: { color: EThemeColor.muted, fontSize: 11, lineHeight: 16 },
})
