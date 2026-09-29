import { NativeTabs } from 'expo-router/unstable-native-tabs'
import { EThemeColor } from '../../src/theme'

export default function TabLayout() {
  return (
    <NativeTabs tintColor={EThemeColor.accent}>
      <NativeTabs.Trigger name="(home)">
        <NativeTabs.Trigger.Icon sf="checklist" md="check_box" />
        <NativeTabs.Trigger.Label>TODO</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="cache">
        <NativeTabs.Trigger.Icon sf="internaldrive.fill" md="storage" />
        <NativeTabs.Trigger.Label>Debug</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon sf="gearshape" md="settings" />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}
