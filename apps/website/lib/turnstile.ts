// MARK: - Cloudflare Turnstile site key

/**
 * The Turnstile site key, sourced ONLY from the environment per deployment
 * (`NEXT_PUBLIC_WEBSITE_TURNSTILE_SITE_KEY`). There is deliberately NO hardcoded
 * fallback: a missing key must fail visibly (the widget doesn't render; see
 * turnstile-verify.ts's fail-open/closed split) rather than silently fall
 * back to Cloudflare's "always passes" test key, which would disable captcha
 * protection in production.
 */
export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_WEBSITE_TURNSTILE_SITE_KEY ?? ''
