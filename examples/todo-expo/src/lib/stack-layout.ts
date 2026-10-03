import type { ReactNode } from 'react'
import { Platform } from 'react-native'
import { EThemeColor } from '../theme'

const IS_IOS = Platform.OS === 'ios'
const IS_IOS_26 = IS_IOS && parseInt(String(Platform.Version), 10) >= 26

/**
 * The header `screenOptions` shared by every tab's native Stack: the large
 * title collapses to compact on scroll only if the screen returns its scroll
 * view as the ROOT (no wrapping View) with contentInsetAdjustmentBehavior="automatic".
 * Blur is version-aware: iOS 26 blurs automatically (an explicit blurEffect
 * there hides the title); earlier iOS needs `regular`. `headerLeft` is the
 * one thing that varies per tab (only the home tab's mark); omit it to match
 * the other tabs' plain large title (@CONVENTIONS.md).
 */
export function stackHeaderOptions(headerLeft?: () => ReactNode) {
  return {
    headerLargeTitle: IS_IOS,
    headerTransparent: IS_IOS,
    headerBlurEffect: IS_IOS_26 ? undefined : ('regular' as const),
    headerShadowVisible: false,
    headerLargeTitleShadowVisible: false,
    headerTintColor: EThemeColor.accent,
    headerTitleStyle: { color: EThemeColor.text },
    headerLargeTitleStyle: { color: EThemeColor.text },
    ...(headerLeft !== undefined ? { headerLeft } : {}),
  } as const
}
