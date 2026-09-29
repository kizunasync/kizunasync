import { Alert, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Column, FieldGroup, Host, Row, Spacer, Text, type UniversalStyle, type UniversalTextStyle } from '@expo/ui'
import type { IInspectorSnapshot, IInspectorVerdict } from '@kizunasync/core'
import { formatRelativeTime, summarizeEngineEvent, type IQueryLogEntry } from '@kizunasync/utilities'
import { RADIUS, SPACING } from '@kizunasync/ui'
import { useCacheInspector } from '../../../src/hooks/use-cache-inspector'
import type { TEngineEventLogEntry } from '../../../src/engine-events'
import { formatInspectorVerdict, OP_COLOR, operationMessage, QUEUE_OP_COLOR, queuedMutationMessage, statTitle, statMessage, type TStatKey } from '../../../src/lib/cache-inspector'
import { EThemeColor } from '../../../src/theme'
import { MAX_WIDTH } from '../../../src/layout-constants'

/**
 * Cache screen, native: a read-only window onto the local command queue + query
 * log, rendered by the platform's own toolkit: a SwiftUI `Form` on iOS, a
 * Material 3 grouped list on Android, from ONE tree of @expo/ui universal
 * components. The web sibling (`index.web.tsx`) shows the same sections in
 * react-native-web. Both read their live data through `useCacheInspector`
 * (@src/hooks/use-cache-inspector.ts); this file only renders it.
 *
 * The universal root's rules, as on the Settings screen: the Host's ONLY child
 * is the FieldGroup (Android renders it as a LazyColumn, which throws when
 * nested in an unbounded parent), the Host ignores the safe area and the group
 * re-applies the insets, and every header/footer slot states its own color
 * because those slots sit outside Compose's LocalContentColor. Tapping a row
 * still opens Alert.alert, because an explanation the reader asked for should
 * interrupt, unlike the verdict toasts.
 */
// MARK: - Cache screen

const SECTION_HEADER_TEXT: UniversalTextStyle = {
  color: EThemeColor.muted,
  fontSize: 11,
  letterSpacing: 1,
}

const STAT_LABEL_TEXT: UniversalTextStyle = { color: EThemeColor.muted, fontSize: 12 }
const STAT_VALUE_TEXT: UniversalTextStyle = { color: EThemeColor.text, fontSize: 14, fontWeight: '600' }
const EMPTY_TEXT: UniversalTextStyle = { color: EThemeColor.muted, fontSize: 12 }
const BADGE_TEXT: UniversalTextStyle = { color: EThemeColor.accentForeground, fontSize: 10, fontWeight: '700' }
const QUEUE_TABLE_TEXT: UniversalTextStyle = { color: EThemeColor.text, fontSize: 13, fontWeight: '600' }
const IN_FLIGHT_TEXT: UniversalTextStyle = { color: EThemeColor.success, fontSize: 10, fontWeight: '700' }
const MUTED_META_TEXT: UniversalTextStyle = { color: EThemeColor.muted, fontSize: 11 }
const LOG_LABEL_TEXT: UniversalTextStyle = { color: EThemeColor.text, fontSize: 12, fontWeight: '600' }
const VERDICT_KIND_TEXT: UniversalTextStyle = { color: EThemeColor.accent, fontSize: 10, fontWeight: '700' }
const VERDICT_REASON_TEXT: UniversalTextStyle = { color: EThemeColor.text, fontSize: 12, lineHeight: 17 }
const EVENT_TYPE_TEXT: UniversalTextStyle = { color: EThemeColor.info, fontSize: 10, fontWeight: '700' }

const CHIP: UniversalStyle = { borderRadius: RADIUS.md, paddingHorizontal: 7, paddingVertical: 2 }
const OUTLINE_CHIP: UniversalStyle = {
  borderRadius: RADIUS.full,
  borderWidth: 1,
  borderColor: EThemeColor.border,
  paddingHorizontal: SPACING[2],
  paddingVertical: 2,
}
const IN_FLIGHT_CHIP: UniversalStyle = { ...OUTLINE_CHIP, borderColor: EThemeColor.success }
const VERDICT_CHIP: UniversalStyle = { ...CHIP, borderRadius: RADIUS.full, backgroundColor: EThemeColor.accentSoft }

export default function CacheScreen() {
  // MARK: - Variables
  const inspector = useCacheInspector()
  const insets = useSafeAreaInsets()

  // MARK: - Render

  const groupInsets: UniversalStyle = { paddingTop: insets.top, paddingBottom: insets.bottom }

  if (!inspector.isEnabled) {
    return (
      <Host style={styles.host} colorScheme="dark" seedColor={EThemeColor.accent} ignoreSafeArea="all">
        <FieldGroup style={groupInsets}>
          <FieldGroup.Section>
            <Text textStyle={EMPTY_TEXT}>inspector disabled</Text>
          </FieldGroup.Section>
        </FieldGroup>
      </Host>
    )
  }

  return (
    <Host style={styles.host} colorScheme="dark" seedColor={EThemeColor.accent} ignoreSafeArea="all">
      <FieldGroup style={groupInsets}>
        <FieldGroup.Section>
          <StatRow label="outbox depth" value={String(inspector.depth)} />
          <StatRow label="cursor" value={inspector.cursor} />
          <StatRow label="last mutation id" value={inspector.lastMutationId} />
        </FieldGroup.Section>

        <FieldGroup.Section>
          <FieldGroup.SectionHeader>
            <Text textStyle={SECTION_HEADER_TEXT}>queued mutations</Text>
          </FieldGroup.SectionHeader>
          {inspector.queued.length === 0 ? (
            <Text textStyle={EMPTY_TEXT}>outbox empty, nothing waiting to push.</Text>
          ) : (
            inspector.queued.map((entry) => <QueueRow key={entry.seq} entry={entry} />)
          )}
        </FieldGroup.Section>

        <FieldGroup.Section>
          <FieldGroup.SectionHeader>
            <Text textStyle={SECTION_HEADER_TEXT}>all operations</Text>
          </FieldGroup.SectionHeader>
          {inspector.visibleLog.length === 0 ? (
            <Text textStyle={EMPTY_TEXT}>no operations recorded yet.</Text>
          ) : (
            inspector.visibleLog.map((entry) => <LogRow key={entry.seq} entry={entry} />)
          )}
        </FieldGroup.Section>

        <FieldGroup.Section>
          <FieldGroup.SectionHeader>
            <Text textStyle={SECTION_HEADER_TEXT}>recent verdicts</Text>
          </FieldGroup.SectionHeader>
          {inspector.verdicts.length === 0 ? (
            <Text textStyle={EMPTY_TEXT}>no rejected or aborted mutations.</Text>
          ) : (
            inspector.verdicts
              .slice()
              .reverse()
              .map((verdict) => <VerdictRow key={`${verdict.mutationId}-${verdict.at}`} verdict={verdict} />)
          )}
        </FieldGroup.Section>

        <FieldGroup.Section>
          <FieldGroup.SectionHeader>
            <Text textStyle={SECTION_HEADER_TEXT}>Engine events</Text>
          </FieldGroup.SectionHeader>
          {inspector.engineEvents.length === 0 ? (
            <Text textStyle={EMPTY_TEXT}>No events yet.</Text>
          ) : (
            inspector.engineEvents
              .slice()
              .reverse()
              .map((entry, index) => <EngineEventRow key={`${entry.at}-${index}`} entry={entry} />)
          )}
        </FieldGroup.Section>
      </FieldGroup>
    </Host>
  )
}

// MARK: - Pieces

function StatRow({ label, value }: { label: TStatKey; value: string }) {
  return (
    <Row alignment="center" spacing={8} onPress={() => Alert.alert(statTitle(label), statMessage(label, value))}>
      <Text textStyle={STAT_LABEL_TEXT}>{label}</Text>
      <Spacer flexible />
      <Text textStyle={STAT_VALUE_TEXT} numberOfLines={1}>
        {value}
      </Text>
    </Row>
  )
}

function QueueRow({ entry }: { entry: IInspectorSnapshot['queued'][number] }) {
  return (
    <Column spacing={6} onPress={() => Alert.alert('Queued mutation', queuedMutationMessage(entry))}>
      <Row alignment="center" spacing={8}>
        <Text style={opChip(QUEUE_OP_COLOR[entry.op] ?? EThemeColor.faint)} textStyle={BADGE_TEXT}>
          {entry.op}
        </Text>
        <Text textStyle={QUEUE_TABLE_TEXT}>{entry.table}</Text>
        {entry.inFlight ? (
          <Text style={IN_FLIGHT_CHIP} textStyle={IN_FLIGHT_TEXT}>
            in-flight
          </Text>
        ) : null}
      </Row>
      <Text textStyle={MUTED_META_TEXT} numberOfLines={1}>
        {`pk ${entry.pk}`}
      </Text>
    </Column>
  )
}

function LogRow({ entry }: { entry: IQueryLogEntry }) {
  return (
    <Row alignment="center" spacing={8} onPress={() => Alert.alert('Operation', operationMessage(entry))}>
      <Text style={opChip(OP_COLOR[entry.op])} textStyle={BADGE_TEXT}>
        {entry.op}
      </Text>
      <Text textStyle={LOG_LABEL_TEXT} numberOfLines={1}>
        {entry.label}
      </Text>
      <Spacer flexible />
      <Text textStyle={MUTED_META_TEXT}>
        {`${entry.rows === null ? 'n/a' : `${String(entry.rows)}r`} · ${String(entry.ms)}ms`}
      </Text>
    </Row>
  )
}

function VerdictRow({ verdict }: { verdict: IInspectorVerdict }) {
  return (
    <Column spacing={6} onPress={() => Alert.alert('Verdict', formatInspectorVerdict(verdict))}>
      <Row alignment="center" spacing={8}>
        <Text style={VERDICT_CHIP} textStyle={VERDICT_KIND_TEXT}>
          {verdict.kind}
        </Text>
        <Text textStyle={MUTED_META_TEXT} numberOfLines={1}>
          {verdict.mutationId}
        </Text>
      </Row>
      <Text textStyle={VERDICT_REASON_TEXT}>{verdict.reason}</Text>
    </Column>
  )
}

function EngineEventRow({ entry }: { entry: TEngineEventLogEntry }) {
  return (
    <Row alignment="center" spacing={8}>
      <Text style={OUTLINE_CHIP} textStyle={EVENT_TYPE_TEXT}>
        {entry.event.type}
      </Text>
      <Text textStyle={MUTED_META_TEXT} numberOfLines={1}>
        {summarizeEngineEvent(entry.event)}
      </Text>
      <Spacer flexible />
      <Text textStyle={MUTED_META_TEXT}>{formatRelativeTime(entry.at)}</Text>
    </Row>
  )
}

// MARK: - internal

/**
 * The traffic-light badge behind an op name, the only per-row color, so it is
 * built from the shared op palette instead of a static style.
 */
function opChip(color: string): UniversalStyle {
  return { ...CHIP, backgroundColor: color }
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
