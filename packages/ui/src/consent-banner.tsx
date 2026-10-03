'use client'

import { useSyncExternalStore } from 'react'
import { COOKIE_POLICY_URL, PRIVACY_POLICY_URL, clearConsentChoice, isConsentBannerDue, isConsentRegion, recordConsentChoice, subscribeConsentChoice } from './tag-manager'

// MARK: - Consent banner

/** Accept and Reject share one class so neither button outweighs the other. */
const CHOICE_BUTTON_CLASS =
  'rounded-lg border border-site-border bg-site-raised px-3 py-1.5 text-xs font-semibold text-site-text transition-colors hover:border-site-faint'

const POLICY_LINK_CLASS = 'text-site-text underline underline-offset-2 hover:text-site-accent'

const COOKIE_SETTINGS_CLASS = 'transition-colors hover:text-site-text'

/**
 * The time zone and the stored choice exist only in the browser, so a server
 * render never shows the banner and it appears after hydration. It stacks
 * above every other layer, including the demo's Turnstile modal and the
 * React Aria overlays at z-index 100000.
 */
export function ConsentBanner({ gtmId }: { gtmId: string }) {
  const isDue = useSyncExternalStore(subscribeConsentChoice, isConsentBannerDue, isHiddenOnServer)

  if (gtmId === '' || !isDue) {
    return null
  }

  return (
    <div role="region" aria-label="Cookie consent" className="fixed inset-x-0 bottom-0 z-[2147483647] p-4">
      <div className="mx-auto flex max-w-2xl flex-col gap-3 rounded-xl border border-site-border bg-site-surface p-4 shadow-site-elevated sm:flex-row sm:items-center">
        <p className="m-0 flex-1 text-sm leading-relaxed text-site-muted">
          If you accept, Google tags may store analytics and advertising cookies on this device, as the{' '}
          <a className={POLICY_LINK_CLASS} href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer">
            privacy policy
          </a>{' '}
          and the{' '}
          <a className={POLICY_LINK_CLASS} href={COOKIE_POLICY_URL} target="_blank" rel="noopener noreferrer">
            cookie policy
          </a>{' '}
          explain.
        </p>
        <div className="flex shrink-0 gap-2">
          <button type="button" className={CHOICE_BUTTON_CLASS} onClick={() => recordConsentChoice('granted')}>
            Accept
          </button>
          <button type="button" className={CHOICE_BUTTON_CLASS} onClick={() => recordConsentChoice('denied')}>
            Reject
          </button>
        </div>
      </div>
    </div>
  )
}

// MARK: - Cookie settings link

/** Forgets the stored choice so the banner asks again. Shown only where the banner can show. */
export function CookieSettingsLink({ gtmId, className = COOKIE_SETTINGS_CLASS }: { gtmId: string; className?: string }) {
  const isShown = useSyncExternalStore(subscribeConsentChoice, isConsentRegion, isHiddenOnServer)

  if (gtmId === '' || !isShown) {
    return null
  }

  return (
    <button type="button" className={className} onClick={clearConsentChoice}>
      Cookie settings
    </button>
  )
}

// MARK: - Pieces

function isHiddenOnServer(): boolean {
  return false
}
