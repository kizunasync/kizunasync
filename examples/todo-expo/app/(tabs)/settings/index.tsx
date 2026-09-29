import { StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button, Column, FieldGroup, Host, Switch, Text, type UniversalStyle, type UniversalTextStyle } from '@expo/ui'
import { useSettingsLab } from '../../../src/hooks/use-settings-lab'
import { EThemeColor } from '../../../src/theme'
import { MAX_WIDTH } from '../../../src/layout-constants'
import { t } from '../../../src/i18n'
import { useSettings } from '../../_layout'

/**
 * Native settings: client toggles and the edge-case lab. One @expo/ui tree
 * becomes a SwiftUI `Form` on iOS and a Material 3 settings list on Android.
 * The web sibling (`index.web.tsx`) uses the same settings in react-native-web.
 * Both share the edge-case lab through `useSettingsLab`
 * (@src/hooks/use-settings-lab.ts).
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
 * Four rules the universal root imposes:
 *   1. The Host's ONLY child is the FieldGroup. Android renders the group as a
 *      LazyColumn, and a lazy list nested in an unbounded parent throws, so no
 *      sibling may share the Host. The screen title rides in a section header
 *      slot, not beside the group.
 *   2. The Host ignores the safe area; the group re-applies the insets so the
 *      platform list draws edge to edge.
 *   3. Header and footer slots sit outside Compose's LocalContentColor, so
 *      each one states its color explicitly.
 *   4. Switch is the only toggle used. A Picker renders irreconcilably across
 *      the two toolkits, and a Checkbox comes out as a switch on iOS anyway.
 */
// MARK: - Settings screen

const SECTION_HEADER_TEXT: UniversalTextStyle = {
  color: EThemeColor.muted,
  fontSize: 11,
  letterSpacing: 1,
}

const SECTION_FOOTER_TEXT: UniversalTextStyle = {
  color: EThemeColor.muted,
  fontSize: 11,
  lineHeight: 16,
}

const MESSAGE_TEXT: UniversalTextStyle = {
  color: EThemeColor.muted,
  fontSize: 12,
  lineHeight: 17,
}

export default function SettingsScreen() {
  // MARK: - Variables
  const { editAnyone, setEditAnyone, live, setLive, offline, setOffline } = useSettings()
  const { message, onForceConflict, onExpireCheckpoint, onResetLocal } = useSettingsLab()
  const insets = useSafeAreaInsets()

  // MARK: - Render
  const groupInsets: UniversalStyle = { paddingTop: insets.top, paddingBottom: insets.bottom }

  return (
    <Host style={styles.host} colorScheme="dark" seedColor={EThemeColor.accent} ignoreSafeArea="all">
      <FieldGroup style={groupInsets}>
        <FieldGroup.Section>
          <FieldGroup.SectionHeader>
            <Text textStyle={SECTION_HEADER_TEXT}>live sync</Text>
          </FieldGroup.SectionHeader>
          <Switch label={t('settings.liveSync')} value={live} onValueChange={setLive} />
          <FieldGroup.SectionFooter>
            <Text textStyle={SECTION_FOOTER_TEXT}>{t('settings.liveSync.hint')}</Text>
          </FieldGroup.SectionFooter>
        </FieldGroup.Section>

        <FieldGroup.Section>
          <FieldGroup.SectionHeader>
            <Text textStyle={SECTION_HEADER_TEXT}>network</Text>
          </FieldGroup.SectionHeader>
          <Switch label="Offline (simulated)" value={offline} onValueChange={setOffline} />
          <FieldGroup.SectionFooter>
            <Text textStyle={SECTION_FOOTER_TEXT}>
              Queues mutations locally with no network; live-sync is suspended. Flip back online to flush the
              outbox and resume.
            </Text>
          </FieldGroup.SectionFooter>
        </FieldGroup.Section>

        <FieldGroup.Section>
          <FieldGroup.SectionHeader>
            <Text textStyle={SECTION_HEADER_TEXT}>reconciliation</Text>
          </FieldGroup.SectionHeader>
          <Switch label={t('settings.editAnyone')} value={editAnyone} onValueChange={setEditAnyone} />
          <FieldGroup.SectionFooter>
            <Text textStyle={SECTION_FOOTER_TEXT}>{t('settings.editAnyone.hint')}</Text>
          </FieldGroup.SectionFooter>
        </FieldGroup.Section>

        <FieldGroup.Section>
          <FieldGroup.SectionHeader>
            <Text textStyle={SECTION_HEADER_TEXT}>edge-case lab</Text>
          </FieldGroup.SectionHeader>
          <Button label="force conflict" variant="text" onPress={onForceConflict} />
          <Button label="expire checkpoint" variant="text" onPress={onExpireCheckpoint} />
          <Button label="reset local" variant="text" onPress={onResetLocal} />
          <FieldGroup.SectionFooter>
            <Column spacing={4}>
              <Text textStyle={SECTION_FOOTER_TEXT}>
                also try: airplane mode, kill the app mid-outbox, two simulators on one account
              </Text>
              {message !== null ? <Text textStyle={MESSAGE_TEXT}>{message}</Text> : null}
            </Column>
          </FieldGroup.SectionFooter>
        </FieldGroup.Section>
      </FieldGroup>
    </Host>
  )
}

// MARK: - Styles

const styles = StyleSheet.create({
  host: {
    flex: 1,
    width: '100%',
    maxWidth: MAX_WIDTH,
    alignSelf: 'center',
    backgroundColor: EThemeColor.background,
  },
})
