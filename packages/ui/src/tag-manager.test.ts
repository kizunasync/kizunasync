/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { CONSENT_REGIONS, CONSENT_STORAGE_KEY, bootstrapTagManager, clearConsentChoice, createTagManagerBootstrapScript, isConsentBannerDue, isConsentRegion, readConsentChoice, recordConsentChoice, subscribeConsentChoice } from './tag-manager'

// MARK: - Fake browser

const GTM_ID = 'GTM-TEST'
const LOADER_URL = `https://www.googletagmanager.com/gtm.js?id=${GTM_ID}`

const GRANTED_DEFAULT = {
  ad_storage: 'granted',
  ad_user_data: 'granted',
  ad_personalization: 'granted',
  analytics_storage: 'granted',
  functionality_storage: 'granted',
  security_storage: 'granted',
}

const REGIONAL_DEFAULT = {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
  functionality_storage: 'granted',
  security_storage: 'granted',
  wait_for_update: 500,
  region: [...CONSENT_REGIONS],
}

interface IFakeScript {
  async: boolean
  src: string
}

interface IFakeBrowser {
  window: { dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void; localStorage: IFakeStorage }
  storage: Map<string, string>

  /** Each loader script with the dataLayer length at the moment it entered the document. */
  inserted: Array<{ script: IFakeScript; dataLayerLength: number }>
}

interface IFakeStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

const REAL_INTL = Intl

/** The DOM the happy-dom preload registered, put back after each test so a test file that runs later in the same process still has it. */
const REAL_WINDOW = Object.getOwnPropertyDescriptor(globalThis, 'window')
const REAL_DOCUMENT = Object.getOwnPropertyDescriptor(globalThis, 'document')

const restoreGlobal = (name: 'window' | 'document', original: PropertyDescriptor | undefined): void => {
  if (original === undefined) {
    Reflect.deleteProperty(globalThis, name)

    return
  }
  Object.defineProperty(globalThis, name, original)
}

const createStorage = (storage: Map<string, string>, isRefusing: boolean): IFakeStorage => ({
  getItem: (key) => {
    if (isRefusing) {
      throw new Error('SecurityError')
    }

    return storage.get(key) ?? null
  },
  setItem: (key, value) => {
    if (isRefusing) {
      throw new Error('QuotaExceededError')
    }
    storage.set(key, value)
  },
  removeItem: (key) => {
    if (isRefusing) {
      throw new Error('SecurityError')
    }
    storage.delete(key)
  },
})

const installBrowser = ({ stored, isRefusing = false }: { stored?: string; isRefusing?: boolean } = {}): IFakeBrowser => {
  const storage = new Map<string, string>()

  if (stored !== undefined) {
    storage.set(CONSENT_STORAGE_KEY, stored)
  }
  const browser: IFakeBrowser = { window: { localStorage: createStorage(storage, isRefusing) }, storage, inserted: [] }
  const fakeDocument = {
    createElement: (): IFakeScript => ({ async: false, src: '' }),
    head: {
      appendChild: (script: IFakeScript) => {
        browser.inserted.push({ script, dataLayerLength: browser.window.dataLayer?.length ?? 0 })
      },
    },
  }

  Object.defineProperty(globalThis, 'window', { value: browser.window, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true, writable: true })

  return browser
}

const installTimeZone = (timeZone: string | null): void => {
  const fakeIntl = timeZone === null ? undefined : { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone }) }) }

  Object.defineProperty(globalThis, 'Intl', { value: fakeIntl, configurable: true, writable: true })
}

const readEntries = (browser: IFakeBrowser): unknown[] => browser.window.dataLayer ?? []

const isArgumentsObject = (value: unknown): boolean => Object.prototype.toString.call(value) === '[object Arguments]'

const readCall = (entry: unknown): unknown[] => {
  expect(isArgumentsObject(entry)).toBe(true)

  return Array.from(entry as ArrayLike<unknown>)
}

beforeEach(() => {
  installBrowser()
  clearConsentChoice()
})

afterEach(() => {
  Object.defineProperty(globalThis, 'Intl', { value: REAL_INTL, configurable: true, writable: true })
  restoreGlobal('window', REAL_WINDOW)
  restoreGlobal('document', REAL_DOCUMENT)
})

// MARK: - Consent regions

describe('CONSENT_REGIONS', () => {
  test('lists the 30 EEA countries plus the United Kingdom and Switzerland as ISO 3166-1 alpha-2 codes', () => {
    expect(CONSENT_REGIONS).toHaveLength(32)
    expect(new Set(CONSENT_REGIONS).size).toBe(32)
    expect(CONSENT_REGIONS.every((code) => /^[A-Z]{2}$/.test(code))).toBe(true)
    expect(CONSENT_REGIONS).toEqual(expect.arrayContaining(['IT', 'DE', 'FR', 'IS', 'LI', 'NO', 'GB', 'CH']))
    expect(CONSENT_REGIONS).not.toContain('US')
  })
})

// MARK: - Bootstrap

describe('bootstrapTagManager', () => {
  test('with no GTM id it touches nothing', () => {
    const browser = installBrowser()

    bootstrapTagManager('')

    expect(browser.window.dataLayer).toBeUndefined()
    expect(browser.window.gtag).toBeUndefined()
    expect(browser.inserted).toHaveLength(0)
  })

  test('pushes the global default, the regional default, and redaction before the gtm.js loader', () => {
    const browser = installBrowser()

    bootstrapTagManager(GTM_ID)
    const entries = readEntries(browser)

    expect(entries).toHaveLength(4)
    expect(readCall(entries[0])).toEqual(['consent', 'default', GRANTED_DEFAULT])
    expect(readCall(entries[1])).toEqual(['consent', 'default', REGIONAL_DEFAULT])
    expect(readCall(entries[2])).toEqual(['set', 'ads_data_redaction', true])
    expect(entries[3]).toEqual({ 'gtm.start': expect.any(Number), event: 'gtm.js' })
    expect(browser.inserted).toHaveLength(1)
    expect(browser.inserted[0]?.script).toEqual({ async: true, src: LOADER_URL })
    expect(browser.inserted[0]?.dataLayerLength).toBe(4)
  })

  test('gtag pushes the arguments object itself, which Consent Mode reads', () => {
    const browser = installBrowser()

    bootstrapTagManager(GTM_ID)
    browser.window.gtag?.('event', 'page_view')
    const entries = readEntries(browser)

    expect(readCall(entries.at(-1))).toEqual(['event', 'page_view'])
  })

  test('a stored choice restores with an update after the defaults and before the loader', () => {
    const browser = installBrowser({ stored: 'denied' })

    bootstrapTagManager(GTM_ID)
    const entries = readEntries(browser)

    expect(readCall(entries[3])).toEqual([
      'consent',
      'update',
      { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied' },
    ])
    expect(entries[4]).toEqual({ 'gtm.start': expect.any(Number), event: 'gtm.js' })
    expect(browser.inserted[0]?.dataLayerLength).toBe(5)
  })

  test('an unknown stored value restores nothing', () => {
    const browser = installBrowser({ stored: 'maybe' })

    bootstrapTagManager(GTM_ID)

    expect(readEntries(browser)).toHaveLength(4)
  })

  test('storage that refuses reads still loads the container with the defaults', () => {
    const browser = installBrowser({ isRefusing: true })

    bootstrapTagManager(GTM_ID)

    expect(readEntries(browser)).toHaveLength(4)
    expect(browser.inserted).toHaveLength(1)
  })
})

describe('createTagManagerBootstrapScript', () => {
  test('the inline script runs the same bootstrap with the consent regions and the storage key', () => {
    const browser = installBrowser({ stored: 'granted' })

    new Function(createTagManagerBootstrapScript(GTM_ID))()
    const entries = readEntries(browser)

    expect(readCall(entries[0])).toEqual(['consent', 'default', GRANTED_DEFAULT])
    expect(readCall(entries[1])).toEqual(['consent', 'default', REGIONAL_DEFAULT])
    expect(readCall(entries[3])).toEqual([
      'consent',
      'update',
      { ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted', analytics_storage: 'granted' },
    ])
    expect(browser.inserted[0]?.script.src).toBe(LOADER_URL)
  })

  test('a value can never close the surrounding script element', () => {
    expect(createTagManagerBootstrapScript('</script><script>alert(1)</script>')).not.toContain('</script>')
  })
})

// MARK: - Consent region

describe('isConsentRegion', () => {
  test('a Europe/* time zone is in the consent region', () => {
    installTimeZone('Europe/Rome')

    expect(isConsentRegion()).toBe(true)
  })

  test('the listed Atlantic, Arctic, and African time zones are in the consent region', () => {
    for (const timeZone of ['Atlantic/Reykjavik', 'Atlantic/Canary', 'Atlantic/Madeira', 'Atlantic/Azores', 'Atlantic/Faroe', 'Arctic/Longyearbyen', 'Africa/Ceuta']) {
      installTimeZone(timeZone)

      expect(isConsentRegion()).toBe(true)
    }
  })

  test('an American time zone is outside the consent region', () => {
    installTimeZone('America/New_York')

    expect(isConsentRegion()).toBe(false)
  })

  test('a browser without Intl is outside the consent region', () => {
    installTimeZone(null)

    expect(isConsentRegion()).toBe(false)
  })
})

// MARK: - Stored choice

describe('consent choice', () => {
  test('Accept stores granted, updates the four storage signals, and pushes consent_update', () => {
    const browser = installBrowser()

    bootstrapTagManager(GTM_ID)
    recordConsentChoice('granted')
    const entries = readEntries(browser)

    expect(browser.storage.get(CONSENT_STORAGE_KEY)).toBe('granted')
    expect(readCall(entries.at(-2))).toEqual([
      'consent',
      'update',
      { ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted', analytics_storage: 'granted' },
    ])
    expect(entries.at(-1)).toEqual({ event: 'consent_update', consent: 'granted' })
    expect(readConsentChoice()).toBe('granted')
  })

  test('Reject stores denied and updates the four storage signals to denied', () => {
    const browser = installBrowser()

    bootstrapTagManager(GTM_ID)
    recordConsentChoice('denied')
    const entries = readEntries(browser)

    expect(browser.storage.get(CONSENT_STORAGE_KEY)).toBe('denied')
    expect(readCall(entries.at(-2))).toEqual([
      'consent',
      'update',
      { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied' },
    ])
    expect(entries.at(-1)).toEqual({ event: 'consent_update', consent: 'denied' })
  })

  test('storage that refuses writes keeps the choice for this page view', () => {
    installBrowser({ isRefusing: true })

    recordConsentChoice('denied')

    expect(readConsentChoice()).toBe('denied')
  })

  test('a choice and a cleared choice both notify subscribers', () => {
    let notified = 0
    const unsubscribe = subscribeConsentChoice(() => {
      notified += 1
    })

    recordConsentChoice('granted')
    clearConsentChoice()
    unsubscribe()
    recordConsentChoice('denied')

    expect(notified).toBe(2)
  })

  test('the banner is due only in the consent region without a stored choice', () => {
    installTimeZone('Europe/Rome')

    expect(isConsentBannerDue()).toBe(true)

    recordConsentChoice('granted')

    expect(isConsentBannerDue()).toBe(false)

    installTimeZone('America/New_York')
    clearConsentChoice()

    expect(isConsentBannerDue()).toBe(false)
  })

  test('clearing the stored choice makes the banner due again', () => {
    const browser = installBrowser({ stored: 'denied' })

    installTimeZone('Europe/Rome')

    expect(isConsentBannerDue()).toBe(false)

    clearConsentChoice()

    expect(browser.storage.has(CONSENT_STORAGE_KEY)).toBe(false)
    expect(isConsentBannerDue()).toBe(true)
  })
})
