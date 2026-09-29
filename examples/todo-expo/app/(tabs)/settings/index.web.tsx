import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { RADIUS, SPACING } from '@kizunasync/ui'
import { useSettingsLab } from '../../../src/hooks/use-settings-lab'
import { EThemeColor } from '../../../src/theme'
import { ToggleSwitch } from '../../../src/components/toggle-switch'
import { WebScreenShell } from '../../../src/components/web-screen-shell'
import { t } from '../../../src/i18n'
import { useSettings } from '../../_layout'

/**
 * Web settings: client toggles and the edge-case lab.
 *
 * The native sibling (`index.tsx`) uses @expo/ui's universal root, which has
 * no browser rendering worth shipping. This react-native-web screen keeps the
 * same copy and the same behavior. Both share the edge-case lab through
 * `useSettingsLab` (@src/hooks/use-settings-lab.ts).
 *
 * `editAnyone` ("Test non-owner edit") lifts the local guard on the registered
 * users' rows only. A write then hits RLS: the server returns RLS_DENIED and
 * the engine reverts it. Every other row on the shared board is already
 * writable.
 * "Live sync" (default on) is the realtime master switch; off, the client
 * syncs only when "sync now" is tapped. The Network section's "Offline
 * (simulated)" toggle tears down the doorbell channel and reports offline, so
 * the engine's own local-write wake reaches no wire. Effective live-sync = live && !offline. The edge-case lab
 * keeps force-conflict / expire-checkpoint / reset-local.
 *
 * WebScreenShell is the ROOT (its ScrollView, no SafeAreaView wrapper). The
 * web tab layout owns the page chrome; there is no header to collapse here.
 */
// MARK: - Settings screen

export default function SettingsScreen() {
  // MARK: - Variables
  const { editAnyone, setEditAnyone, live, setLive, offline, setOffline } = useSettings()
  const { message, onForceConflict, onExpireCheckpoint, onResetLocal } = useSettingsLab()

  // MARK: - Render
  return (
    <WebScreenShell>
      <Text style={styles.sectionTitle}>live sync</Text>
      <ToggleRow
        label={t('settings.liveSync')}
        hint={t('settings.liveSync.hint')}
        value={live}
        onToggle={() => setLive(!live)}
      />

      <Text style={styles.sectionTitle}>network</Text>
      <ToggleRow
        label="Offline (simulated)"
        hint="Queues mutations locally with no network; live-sync is suspended. Flip back online to flush the outbox and resume."
        value={offline}
        onToggle={() => setOffline(!offline)}
      />

      <Text style={styles.sectionTitle}>reconciliation</Text>
      <ToggleRow
        label={t('settings.editAnyone')}
        hint={t('settings.editAnyone.hint')}
        value={editAnyone}
        onToggle={() => setEditAnyone(!editAnyone)}
      />

      <Text style={styles.sectionTitle}>edge-case lab</Text>
      <View style={styles.panel}>
        <View style={styles.panelRow}>
          <PanelButton label="force conflict" onPress={onForceConflict} />
          <PanelButton label="expire checkpoint" onPress={onExpireCheckpoint} />
          <PanelButton label="reset local" onPress={onResetLocal} />
        </View>
        <Text style={styles.panelHint}>
          also try: airplane mode, kill the app mid-outbox, two simulators on one account
        </Text>
        {message !== null ? <Text style={styles.message}>{message}</Text> : null}
      </View>
    </WebScreenShell>
  )
}

// MARK: - Pieces

function ToggleRow({
  label,
  hint,
  value,
  onToggle,
}: {
  label: string
  hint: string
  value: boolean
  onToggle: () => void
}) {
  return (
    <Pressable style={styles.toggleRow} onPress={onToggle}>
      <View style={styles.toggleText}>
        <Text style={styles.toggleLabel}>{label}</Text>
        <Text style={styles.toggleHint}>{hint}</Text>
      </View>
      <ToggleSwitch value={value} />
    </Pressable>
  )
}

function PanelButton({ label, onPress }: { label: string; onPress: () => void }) {
  const [hovered, setHovered] = useState(false)

  return (
    <Pressable
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={[styles.panelButton, hovered && styles.panelButtonHover]}
    >
      <Text style={styles.panelButtonText}>{label}</Text>
    </Pressable>
  )
}

// MARK: - Styles

const styles = StyleSheet.create({
  sectionTitle: {
    color: EThemeColor.muted,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: SPACING[2],
  },

  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING[3],
    backgroundColor: EThemeColor.surfaceElevated,
    borderWidth: 1,
    borderColor: EThemeColor.hairline,
    borderRadius: RADIUS.xl,
    padding: 13,
  },
  toggleText: { flex: 1, gap: 3 },
  toggleLabel: { color: EThemeColor.text, fontSize: 14, fontWeight: '600' },
  toggleHint: { color: EThemeColor.muted, fontSize: 11, lineHeight: 16 },

  panel: {
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: EThemeColor.hairline,
    backgroundColor: EThemeColor.panel,
    padding: 13,
    gap: SPACING[2],
  },
  panelRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING[2] },
  panelButton: {
    borderWidth: 1,
    borderColor: EThemeColor.panelBorder,
    borderRadius: RADIUS.lg,
    paddingHorizontal: 11,
    paddingVertical: 6,
    backgroundColor: 'transparent',
  },
  panelButtonHover: { backgroundColor: EThemeColor.accentSoft, borderColor: EThemeColor.accent },
  panelButtonText: { color: EThemeColor.accent, fontSize: 12, fontWeight: '600' },
  panelHint: { color: EThemeColor.muted, fontSize: 11, lineHeight: 16 },
  message: { color: EThemeColor.muted, fontSize: 12, lineHeight: 17 },
})
