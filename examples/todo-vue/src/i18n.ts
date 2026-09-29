/**
 * Deliberately the /i18n subpath, not the @kizunasync/ui barrel: the barrel pulls
 * BrandMark's JSX into vue-tsc's compile graph, which it cannot resolve
 * (TS7026). Same toolchain-constraint class as this app's TypeScript 6 pin.
 */
import { DEFAULT_LOCALE, t as translate, type TLocaleKey, type TTranslationVars } from '@kizunasync/ui/i18n'

/** This demo ships a single locale; bind the shared dictionary to it so screens call t(key) directly. */
const LOCALE = DEFAULT_LOCALE

export function t(key: TLocaleKey, vars?: TTranslationVars): string {
  return translate(LOCALE, key, vars)
}
