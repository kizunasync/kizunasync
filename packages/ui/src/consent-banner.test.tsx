import '../happydom'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { CONSENT_STORAGE_KEY, clearConsentChoice } from './tag-manager'
import { ConsentBanner, CookieSettingsLink } from './consent-banner'

// MARK: - Fake time zone

const GTM_ID = 'GTM-TEST'
const REAL_INTL = Intl

const installTimeZone = (timeZone: string): void => {
  Object.defineProperty(globalThis, 'Intl', {
    value: { ...REAL_INTL, DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone }) }) },
    configurable: true,
    writable: true,
  })
}

beforeEach(() => {
  installTimeZone('Europe/Rome')
  window.localStorage.clear()
  clearConsentChoice()
})

afterEach(() => {
  cleanup()
  Object.defineProperty(globalThis, 'Intl', { value: REAL_INTL, configurable: true, writable: true })
  window.localStorage.clear()
  window.gtag = undefined
  window.dataLayer = undefined
})

// MARK: - ConsentBanner

describe('ConsentBanner', () => {
  test('renders in the consent region with no stored choice', () => {
    const view = render(React.createElement(ConsentBanner, { gtmId: GTM_ID }))

    expect(view.getByRole('region', { name: 'Cookie consent' })).toBeTruthy()
  })

  test('renders nothing without a GTM id', () => {
    const view = render(React.createElement(ConsentBanner, { gtmId: '' }))

    expect(view.queryByRole('region', { name: 'Cookie consent' })).toBeNull()
  })

  test('renders nothing outside the consent region', () => {
    installTimeZone('America/New_York')
    const view = render(React.createElement(ConsentBanner, { gtmId: GTM_ID }))

    expect(view.queryByRole('region', { name: 'Cookie consent' })).toBeNull()
  })

  test('renders nothing with a stored choice', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, 'granted')
    const view = render(React.createElement(ConsentBanner, { gtmId: GTM_ID }))

    expect(view.queryByRole('region', { name: 'Cookie consent' })).toBeNull()
  })

  test('Accept stores the choice and calls the consent update', () => {
    const calls: unknown[][] = []

    window.gtag = (...args: unknown[]) => calls.push(args)
    window.dataLayer = []
    const view = render(React.createElement(ConsentBanner, { gtmId: GTM_ID }))

    fireEvent.click(view.getByText('Accept'))

    expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBe('granted')
    expect(calls).toContainEqual([
      'consent',
      'update',
      { ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted', analytics_storage: 'granted' },
    ])
    expect(window.dataLayer.at(-1)).toEqual({ event: 'consent_update', consent: 'granted' })
    expect(view.queryByRole('region', { name: 'Cookie consent' })).toBeNull()
  })

  test('Reject stores the choice and calls the consent update', () => {
    const calls: unknown[][] = []

    window.gtag = (...args: unknown[]) => calls.push(args)
    window.dataLayer = []
    const view = render(React.createElement(ConsentBanner, { gtmId: GTM_ID }))

    fireEvent.click(view.getByText('Reject'))

    expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBe('denied')
    expect(calls).toContainEqual([
      'consent',
      'update',
      { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied' },
    ])
    expect(window.dataLayer.at(-1)).toEqual({ event: 'consent_update', consent: 'denied' })
    expect(view.queryByRole('region', { name: 'Cookie consent' })).toBeNull()
  })
})

// MARK: - CookieSettingsLink

describe('CookieSettingsLink', () => {
  test('renders inside the consent region', () => {
    const view = render(React.createElement(CookieSettingsLink, { gtmId: GTM_ID }))

    expect(view.getByText('Cookie settings')).toBeTruthy()
  })

  test('renders nothing without a GTM id', () => {
    const view = render(React.createElement(CookieSettingsLink, { gtmId: '' }))

    expect(view.queryByText('Cookie settings')).toBeNull()
  })

  test('renders nothing outside the consent region', () => {
    installTimeZone('America/New_York')
    const view = render(React.createElement(CookieSettingsLink, { gtmId: GTM_ID }))

    expect(view.queryByText('Cookie settings')).toBeNull()
  })

  test('clears the stored choice and shows the banner again', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, 'granted')
    const view = render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(ConsentBanner, { gtmId: GTM_ID }),
        React.createElement(CookieSettingsLink, { gtmId: GTM_ID }),
      ),
    )

    expect(view.queryByRole('region', { name: 'Cookie consent' })).toBeNull()

    fireEvent.click(view.getByText('Cookie settings'))

    expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBeNull()
    expect(view.getByRole('region', { name: 'Cookie consent' })).toBeTruthy()
  })
})
