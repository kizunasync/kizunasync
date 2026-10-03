import { DEFAULT_LOCALE, t as translate, type TLocaleKey, type TTranslationVars } from '@kizunasync/ui'

/** This demo ships a single locale; bind the shared dictionary to it so screens call t(key) directly. */
const LOCALE = DEFAULT_LOCALE

export function t(key: TLocaleKey, vars?: TTranslationVars): string {
  return translate(LOCALE, key, vars)
}
