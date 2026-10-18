import { requireOptionalNativeModule } from 'expo-modules-core'
import type { IKizunaExpoModule } from './native-module.types'

/** Resolve the autolinked Expo module only when the client first needs it. */
export function getNativeModule(): IKizunaExpoModule | null {
  return requireOptionalNativeModule<IKizunaExpoModule>('KizunaSyncExpo')
}
