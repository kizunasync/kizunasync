import type { IKizunaExpoModule } from './native-module.types'

/** SSR and non-native hosts never initialize Expo's JSI runtime. */
export function getNativeModule(): IKizunaExpoModule | null {
  return null
}
