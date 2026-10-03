/**
 * A Turnstile site key marks the hosted public demo project. Its hardening
 * (@../../../../packages/supabase-pack/supabase/demo/0001_public_demo_hardening.sql)
 * refuses every sign-in without a Turnstile token, leaves no password account,
 * and removes the Storage upload surface, so the app drops those paths when the
 * key is set.
 */

import Constants from 'expo-constants'
import type { IRecoverAnonymousSessionOptions } from 'kizunasync/supabase'
import { createCaptchaGate } from '@kizunasync/utilities'

const rawSiteKey: unknown = Constants.expoConfig?.extra?.turnstileSiteKey

export const TURNSTILE_SITE_KEY: string = typeof rawSiteKey === 'string' ? rawSiteKey.trim() : ''

export const IS_PUBLIC_DEMO: boolean = TURNSTILE_SITE_KEY !== ''

export const captchaGate = createCaptchaGate()

export function captchaTokenOption(): IRecoverAnonymousSessionOptions {
  return IS_PUBLIC_DEMO ? { captchaToken: () => captchaGate.request() } : {}
}
