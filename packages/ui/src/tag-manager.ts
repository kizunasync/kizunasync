/**
 * Google Tag Manager with Consent Mode v2, shared by the website and the demo.
 * Every visitor starts with all storage granted, except in CONSENT_REGIONS,
 * where ads and analytics storage stay denied until the visitor accepts.
 * Google applies that regional default by IP address; isConsentRegion() only
 * decides whether the banner shows.
 */

// MARK: - Types

export type TConsentChoice = 'granted' | 'denied'

/**
 * Everything the bootstrap reads. It comes in as one parameter because the
 * website ships the bootstrap's source text as an inline script, where module
 * scope does not exist.
 */
export interface ITagManagerBootstrapOptions {
  gtmId: string
  regions: readonly string[]
  storageKey: string
}

declare global {
  interface Window {
    dataLayer?: unknown[]
    gtag?: (...args: unknown[]) => void
  }
}

// MARK: - Constants

/** The EEA (the EU plus Iceland, Liechtenstein, and Norway), the United Kingdom, and Switzerland, as ISO 3166-1 alpha-2 codes. */
export const CONSENT_REGIONS = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO',
  'GB', 'CH',
] as const

export const CONSENT_STORAGE_KEY = 'kizunasync.consent'

export const PRIVACY_POLICY_URL = 'https://www.iubenda.com/privacy-policy/86449130'

export const COOKIE_POLICY_URL = 'https://www.iubenda.com/privacy-policy/86449130/cookie-policy'

/** Consent-region time zones outside `Europe/`. */
const CONSENT_TIME_ZONES: readonly string[] = ['Atlantic/Reykjavik', 'Atlantic/Canary', 'Atlantic/Madeira', 'Atlantic/Azores', 'Atlantic/Faroe', 'Arctic/Longyearbyen', 'Africa/Ceuta']

const TAG_MANAGER_NOSCRIPT_URL = 'https://www.googletagmanager.com/ns.html?id='

// MARK: - Bootstrap

/**
 * Sets the two consent defaults, restores a stored choice, then loads the
 * container. It must run before any other script on the page, and it uses
 * nothing but its parameter and browser globals, because
 * createTagManagerBootstrapScript() serializes its source text. With an empty
 * `gtmId` it does nothing at all.
 */
export function runTagManagerBootstrap({ gtmId, regions, storageKey }: ITagManagerBootstrapOptions): void {
  if (gtmId === '') {
    return
  }
  const dataLayer = window.dataLayer ?? []
  const waitForUpdateMs = 500
  let storedChoice: string | null = null

  window.dataLayer = dataLayer
  function gtag(..._args: unknown[]): void {
    // Consent Mode reads the arguments object itself and ignores an array copy.
    dataLayer.push(arguments)
  }
  window.gtag = gtag
  gtag('consent', 'default', {
    ad_storage: 'granted',
    ad_user_data: 'granted',
    ad_personalization: 'granted',
    analytics_storage: 'granted',
    functionality_storage: 'granted',
    security_storage: 'granted',
  })
  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    functionality_storage: 'granted',
    security_storage: 'granted',
    wait_for_update: waitForUpdateMs,
    region: regions,
  })
  gtag('set', 'ads_data_redaction', true)

  try {
    storedChoice = window.localStorage.getItem(storageKey)
  } catch {
    // Private windows can refuse storage; the defaults then stand.
  }

  if (storedChoice === 'granted' || storedChoice === 'denied') {
    gtag('consent', 'update', {
      ad_storage: storedChoice,
      ad_user_data: storedChoice,
      ad_personalization: storedChoice,
      analytics_storage: storedChoice,
    })
  }
  dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' })
  const loader = document.createElement('script')

  loader.async = true
  loader.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(gtmId)}`
  document.head.appendChild(loader)
}

/** Runs the bootstrap in the current page. The demo calls it from bundled code, since its CSP admits no inline script. */
export function bootstrapTagManager(gtmId: string): void {
  runTagManagerBootstrap({ gtmId, regions: CONSENT_REGIONS, storageKey: CONSENT_STORAGE_KEY })
}

/** Inline script source that runs the bootstrap, for a page whose CSP allows inline scripts (the website). */
export function createTagManagerBootstrapScript(gtmId: string): string {
  const options: ITagManagerBootstrapOptions = { gtmId, regions: CONSENT_REGIONS, storageKey: CONSENT_STORAGE_KEY }

  // Escaping `<` keeps a value from closing the surrounding script element.
  return `(${runTagManagerBootstrap.toString()})(${JSON.stringify(options).replaceAll('<', '\\u003c')})`
}

/** The container URL for the `<noscript>` iframe that follows the opening `<body>` tag. */
export function createTagManagerNoscriptUrl(gtmId: string): string {
  return `${TAG_MANAGER_NOSCRIPT_URL}${encodeURIComponent(gtmId)}`
}

// MARK: - Consent region

/**
 * Whether the browser time zone sits in a consent region. It decides only
 * whether the banner shows. A browser without `Intl` counts as outside.
 */
export function isConsentRegion(): boolean {
  let timeZone: unknown

  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return false
  }

  return typeof timeZone === 'string' && (timeZone.startsWith('Europe/') || CONSENT_TIME_ZONES.includes(timeZone))
}

// MARK: - Stored choice

const consentListeners = new Set<() => void>()

/** The choice made on this page view, which still counts when storage refuses the write (private windows). */
let pageChoice: TConsentChoice | null = null

function notifyConsentListeners(): void {
  for (const listener of consentListeners) {
    listener()
  }
}

export function readConsentChoice(): TConsentChoice | null {
  try {
    const storedChoice = window.localStorage.getItem(CONSENT_STORAGE_KEY)

    if (storedChoice === 'granted' || storedChoice === 'denied') {
      return storedChoice
    }
  } catch {
    // Private windows can refuse storage; the choice made on this page view still holds.
  }

  return pageChoice
}

/** Stores the visitor's choice, updates the four storage signals, and pushes a `consent_update` event. */
export function recordConsentChoice(choice: TConsentChoice): void {
  pageChoice = choice

  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, choice)
  } catch {
    // Private windows can refuse storage; the choice then lasts for this page view.
  }
  window.gtag?.('consent', 'update', {
    ad_storage: choice,
    ad_user_data: choice,
    ad_personalization: choice,
    analytics_storage: choice,
  })
  window.dataLayer?.push({ event: 'consent_update', consent: choice })
  notifyConsentListeners()
}

/** Forgets the stored choice, so the banner asks again. The consent state of the current page view stays as it is. */
export function clearConsentChoice(): void {
  pageChoice = null

  try {
    window.localStorage.removeItem(CONSENT_STORAGE_KEY)
  } catch {
    // Private windows can refuse storage; nothing was stored to remove.
  }
  notifyConsentListeners()
}

export function subscribeConsentChoice(listener: () => void): () => void {
  consentListeners.add(listener)

  return () => {
    consentListeners.delete(listener)
  }
}

export function isConsentBannerDue(): boolean {
  return isConsentRegion() && readConsentChoice() === null
}
