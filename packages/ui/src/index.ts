/**
 * Cross-app React components. Consumers need `transpilePackages: ['@kizunasync/ui']`
 * in next.config (the package ships TypeScript source).
 */

// MARK: - @kizunasync/ui public surface

export { BrandMark } from './brand-mark'
export { TurnstileWidget } from './turnstile-widget'
export { ConsentBanner, CookieSettingsLink } from './consent-banner'
export { KSYNC_PALETTE, type TKizunaSyncPalette } from './palette'
export { KSYNC_THEME_VARS } from './theme-vars'
export { t, DEFAULT_LOCALE, type TLocaleKey, type TTranslationVars } from './i18n'
export { SPACING, RADIUS } from './spacing'
export { ICONS, type TIconName } from './icons'
export { ROW_ICON_PATHS, type TRowIconName } from './icon-paths'
export { CONSENT_REGIONS, CONSENT_STORAGE_KEY, COOKIE_POLICY_URL, PRIVACY_POLICY_URL, bootstrapTagManager, clearConsentChoice, createTagManagerBootstrapScript, createTagManagerNoscriptUrl, isConsentBannerDue, isConsentRegion, readConsentChoice, recordConsentChoice, runTagManagerBootstrap, subscribeConsentChoice, type ITagManagerBootstrapOptions, type TConsentChoice } from './tag-manager'
