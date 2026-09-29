import { Stack } from 'expo-router'
import { stackHeaderOptions } from '../../../src/lib/stack-layout'

/**
 * Native Stack for the Settings tab. `_layout.web.tsx` renders a bare Slot;
 * the web segmented nav owns the chrome. The header options are the shared
 * `stackHeaderOptions` (@src/lib/stack-layout.ts).
 */
export default function SettingsStackLayout() {
  return (
    <Stack screenOptions={stackHeaderOptions()}>
      <Stack.Screen name="index" options={{ title: 'Settings' }} />
    </Stack>
  )
}
