import { useState, type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { SPACING } from '@kizunasync/ui'
import { useCacheInspector } from '../../../src/hooks/use-cache-inspector'
import { CacheDetailModal, type TCacheDetail } from '../../../src/components/cache/cache-detail-modal'
import { CacheEventRow } from '../../../src/components/cache/cache-event-row'
import { CacheLogRow } from '../../../src/components/cache/cache-log-row'
import { CacheQueueRow } from '../../../src/components/cache/cache-queue-row'
import { CacheStat } from '../../../src/components/cache/cache-stat'
import { CacheVerdictRow } from '../../../src/components/cache/cache-verdict-row'
import { EThemeColor } from '../../../src/theme'
import { WebScreenShell } from '../../../src/components/web-screen-shell'

/**
 * Cache screen, web: a read-only view of the local command queue and query log.
 *
 * The native sibling (`index.tsx`) shows the same five sections through
 * @expo/ui's universal root. The browser gets this react-native-web screen.
 * Both read their live data through `useCacheInspector`
 * (@src/hooks/use-cache-inspector.ts); this file only renders it.
 *
 * WebScreenShell is the ROOT (its ScrollView, no SafeAreaView wrapper). The
 * web tab layout owns the page chrome; there is no header to collapse here.
 *
 * Tapping a row opens `CacheDetailModal`. react-native-web implements
 * Alert.alert as an empty function, so the native screen's system alert would
 * not appear here.
 */
// MARK: - Cache screen

export default function CacheScreen() {
  // MARK: - Variables
  const inspector = useCacheInspector()
  const [detail, setDetail] = useState<TCacheDetail | null>(null)

  // MARK: - Render

  if (!inspector.isEnabled) {
    return (
      <WebScreenShell>
        <Text style={styles.disabled}>inspector disabled</Text>
      </WebScreenShell>
    )
  }

  return (
    <>
      <WebScreenShell>
        <View style={styles.statsRow}>
          <CacheStat
            label="outbox depth"
            value={String(inspector.depth)}
            onPress={() => setDetail({ kind: 'stat', stat: 'outbox depth', value: String(inspector.depth) })}
          />
          <CacheStat
            label="cursor"
            value={inspector.cursor}
            onPress={() => setDetail({ kind: 'stat', stat: 'cursor', value: inspector.cursor })}
          />
        </View>
        <CacheStat
          label="last mutation id"
          value={inspector.lastMutationId}
          full
          onPress={() => setDetail({ kind: 'stat', stat: 'last mutation id', value: inspector.lastMutationId })}
        />

        <CacheSection
          title="queued mutations"
          empty="outbox empty, nothing waiting to push."
          isEmpty={inspector.queued.length === 0}
        >
          {inspector.queued.map((entry) => (
            <CacheQueueRow key={entry.seq} entry={entry} onPress={() => setDetail({ kind: 'queued', entry })} />
          ))}
        </CacheSection>

        <CacheSection title="all operations" titleWrap empty="no operations recorded yet." isEmpty={inspector.visibleLog.length === 0}>
          {inspector.visibleLog.map((entry) => (
            <CacheLogRow key={entry.seq} entry={entry} onPress={() => setDetail({ kind: 'operation', entry })} />
          ))}
        </CacheSection>

        <CacheSection title="recent verdicts" empty="no rejected or aborted mutations." isEmpty={inspector.verdicts.length === 0}>
          {inspector.verdicts
            .slice()
            .reverse()
            .map((verdict) => (
              <CacheVerdictRow
                key={`${verdict.mutationId}-${verdict.at}`}
                verdict={verdict}
                onPress={() => setDetail({ kind: 'verdict', verdict })}
              />
            ))}
        </CacheSection>

        <CacheSection title="Engine events" empty="No events yet." isEmpty={inspector.engineEvents.length === 0}>
          {inspector.engineEvents
            .slice()
            .reverse()
            .map((entry, index) => <CacheEventRow key={`${entry.at}-${index}`} entry={entry} />)}
        </CacheSection>
      </WebScreenShell>
      <CacheDetailModal detail={detail} onClose={() => setDetail(null)} />
    </>
  )
}

// MARK: - Pieces

/**
 * One list section: a divider, the title, and either `children` or `empty`
 * text. `titleWrap` reproduces the "all operations" header's row wrapper
 * (`logHead`), the one section whose title sits in its own flex row.
 */
function CacheSection({
  title,
  titleWrap = false,
  empty,
  isEmpty,
  children,
}: {
  title: string
  titleWrap?: boolean
  empty: string
  isEmpty: boolean
  children: ReactNode
}) {
  const heading = <Text style={styles.sectionTitle}>{title}</Text>

  return (
    <>
      <View style={styles.hr} />
      {titleWrap ? <View style={styles.logHead}>{heading}</View> : heading}
      {isEmpty ? <Text style={styles.empty}>{empty}</Text> : children}
    </>
  )
}

// MARK: - Styles

const styles = StyleSheet.create({
  disabled: { color: EThemeColor.muted, textAlign: 'center', marginTop: SPACING[8] },

  hr: { height: 1, backgroundColor: EThemeColor.hairline, marginVertical: 2 },

  statsRow: { flexDirection: 'row', gap: SPACING[3] },

  sectionTitle: {
    color: EThemeColor.muted,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: SPACING[2],
  },
  empty: { color: EThemeColor.muted, fontSize: 12 },

  logHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
})
