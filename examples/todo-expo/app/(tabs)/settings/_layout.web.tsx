import { Slot } from 'expo-router'

/**
 * Web sibling of the native `_layout.tsx`. The web tab layout (`(tabs)/_layout.web.tsx`)
 * already supplies the segmented nav, so the settings group renders its child
 * route with no extra header here.
 */
export default function SettingsWebLayout() {
  return <Slot />
}
