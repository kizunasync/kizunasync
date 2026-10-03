/**
 * The inline page the native WebView renders to run the Cloudflare Turnstile
 * check, plus the strict parser for the messages that page posts back.
 */

/**
 * The WebView document needs an origin the widget lists among its hostnames;
 * the public demo's widget lists `localhost`, and it refuses `127.0.0.1`.
 */
export const TURNSTILE_DOCUMENT_ORIGIN = 'http://localhost'

export const TURNSTILE_ACTION = 'todo-expo-visitor-v1'

export type TTurnstileMessage = { kind: 'token'; token: string } | { kind: 'error'; code: string } | { kind: 'expired' }

function escapeForScript(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

export function buildTurnstileDocument(options: { siteKey: string; action: string }): string {
  const siteKey = escapeForScript(options.siteKey)
  const action = escapeForScript(options.action)

  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<style>body { margin: 0; background: transparent; }</style>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad" async defer></script>
</head>
<body>
<div id="widget"></div>
<script>
function post(message) {
  window.ReactNativeWebView.postMessage(JSON.stringify(message))
}
function onTurnstileLoad() {
  window.turnstile.render('#widget', {
    sitekey: ${siteKey},
    action: ${action},
    theme: 'dark',
    size: 'flexible',
    callback: function (token) { post({ type: 'token', token: token }) },
    'error-callback': function (code) { post({ type: 'error', code: String(code) }) },
    'expired-callback': function () { post({ type: 'expired' }) },
  })
}
</script>
</body>
</html>`
}

function decodeTurnstileMessage(value: unknown): TTurnstileMessage | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { type, token, code } = value as { type?: unknown; token?: unknown; code?: unknown }

  if (type === 'token' && typeof token === 'string' && token !== '') {
    return { kind: 'token', token }
  }
  if (type === 'error' && typeof code === 'string') {
    return { kind: 'error', code }
  }

  return type === 'expired' ? { kind: 'expired' } : null
}

export function parseTurnstileMessage(raw: unknown): TTurnstileMessage | null {
  if (typeof raw !== 'string') {
    return null
  }
  try {
    return decodeTurnstileMessage(JSON.parse(raw))
  } catch {
    return null
  }
}
