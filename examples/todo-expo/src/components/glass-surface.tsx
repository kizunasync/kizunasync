import type { ViewStyle } from 'react-native'
import { GlassView, isGlassEffectAPIAvailable } from 'expo-glass-effect'

/**
 * Liquid glass, guarded.
 *
 * Only iOS 26+ exposes the glass API; Android and earlier iOS keep the opaque
 * "sumi & vermilion" surfaces unchanged. The capability cannot change while
 * the app runs, so it is resolved once here and callers branch on the
 * constant: `IS_GLASS_AVAILABLE ? <the transparent host style> : null` beside
 * their normal style, plus a `<GlassSurface>` layer. When the API is missing
 * the layer renders nothing and the original style stands alone.
 *
 * The layer is absolutely positioned; it never joins the host's flex line.
 * The host adds `overflow: 'hidden'` in the glass branch so the layer is
 * clipped to the host's box whatever the parent's padding.
 */
export const IS_GLASS_AVAILABLE = isGlassEffectAPIAvailable()

export function GlassSurface({ style }: { style: ViewStyle }) {
  if (!IS_GLASS_AVAILABLE) {
    return null
  }
  return <GlassView style={style} glassEffectStyle="regular" colorScheme="dark" pointerEvents="none" />
}
