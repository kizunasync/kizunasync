/**
 * Web-only tab layout. Expo Router resolves this `.web.tsx` on web and falls back
 * to `_layout.tsx` (NativeTabs) on device, so native keeps its native tab bar
 * untouched. It hosts the same two child routes (index=TODO, cache=Cache) via
 * `<Slot/>` and supplies a responsive nav: a centered top bar with a segmented
 * toggle on large screens, a compact full-width bottom segment bar on small ones.
 * Navigation is `router.replace` (tab semantics, no back-stack growth). The
 * client lifecycle, KizunaSyncProvider and SessionContext live in app/_layout.tsx and
 * are untouched here.
 */

import { StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, Slot, usePathname } from 'expo-router'
import { SPACING } from '@kizunasync/ui'
import { EThemeColor } from '../../src/theme'
import { MAX_WIDTH } from '../../src/layout-constants'
import { SegmentPill } from '../../src/components/segment-pill'

const LARGE_SCREEN_MIN_WIDTH = 768

interface ITab {
  label: string
  glyph: string
  path: '/' | '/cache' | '/settings'
}

const TABS: ITab[] = [
  { label: 'TODO', glyph: '✓', path: '/' },
  { label: 'Debug', glyph: '◉', path: '/cache' },
  { label: 'Settings', glyph: '⚙', path: '/settings' },
]

function resolveActivePath(pathname: string): ITab['path'] {
  if (pathname.endsWith('cache')) {
    return '/cache'
  }
  if (pathname.endsWith('settings')) {
    return '/settings'
  }
  return '/'
}

export default function WebTabLayout() {
  // MARK: - Variables
  const { width } = useWindowDimensions()
  const isLarge = width >= LARGE_SCREEN_MIN_WIDTH
  const pathname = usePathname()
  const activePath: ITab['path'] = resolveActivePath(pathname)

  // MARK: - Render
  return (
    <SafeAreaView style={styles.root}>
      <TopNav activePath={activePath} showSegment={isLarge} />
      <View style={styles.content}>
        <Slot />
      </View>
      {isLarge ? null : <BottomNav activePath={activePath} />}
    </SafeAreaView>
  )
}

// MARK: - Pieces

function TopNav({ activePath, showSegment }: { activePath: ITab['path']; showSegment: boolean }) {
  return (
    <View style={styles.topNav}>
      <View style={styles.topNavInner}>
        <View style={styles.brandRow}>
          <Text style={styles.brandGlyph}>絆</Text>
          <Text style={styles.brand}>Kizuna Sync</Text>
        </View>
        {showSegment ? (
          <View style={styles.segment}>
            {TABS.map((tab) => (
              <TabPill key={tab.path} tab={tab} active={activePath === tab.path} />
            ))}
          </View>
        ) : null}
      </View>
    </View>
  )
}

function BottomNav({ activePath }: { activePath: ITab['path'] }) {
  return (
    <View style={styles.bottomNav}>
      <View style={styles.segmentFull}>
        {TABS.map((tab) => (
          <TabPill key={tab.path} tab={tab} active={activePath === tab.path} grow />
        ))}
      </View>
    </View>
  )
}

function TabPill({ tab, active, grow }: { tab: ITab; active: boolean; grow?: boolean }) {
  return (
    <SegmentPill
      label={tab.label}
      glyph={tab.glyph}
      active={active}
      grow={grow}
      onPress={() => {
        if (!active) {
          router.replace(tab.path)
        }
      }}
    />
  )
}

// MARK: - Styles

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: EThemeColor.background },
  content: { flex: 1 },

  topNav: {
    borderBottomWidth: 1,
    borderBottomColor: EThemeColor.hairline,
    backgroundColor: EThemeColor.surface,
  },
  topNavInner: {
    width: '100%',
    maxWidth: MAX_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: SPACING[4],
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  brandRow: { flexDirection: 'row', alignItems: 'baseline', gap: SPACING[2] },
  brandGlyph: { color: EThemeColor.accent, fontSize: 20, fontWeight: '700' },
  brand: { color: EThemeColor.text, fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },

  segment: { flexDirection: 'row', gap: SPACING[1] },

  bottomNav: {
    borderTopWidth: 1,
    borderTopColor: EThemeColor.hairline,
    backgroundColor: EThemeColor.surface,
    paddingHorizontal: SPACING[4],
    paddingTop: SPACING[2],
    paddingBottom: SPACING[2],
  },
  segmentFull: { flexDirection: 'row', gap: SPACING[1] },
})
