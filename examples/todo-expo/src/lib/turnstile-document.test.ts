/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { buildTurnstileDocument, parseTurnstileMessage } from './turnstile-document'

describe('buildTurnstileDocument', () => {
  const html = buildTurnstileDocument({ siteKey: '0xSITEKEY', action: 'visitor-v1' })

  test('loads the Turnstile api and renders with the escaped site key and action', () => {
    expect(html).toContain('https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad')
    expect(html).toContain('sitekey: "0xSITEKEY"')
    expect(html).toContain('action: "visitor-v1"')
  })

  test('posts the three message types through ReactNativeWebView', () => {
    expect(html).toContain('window.ReactNativeWebView.postMessage')
    expect(html).toContain("type: 'token'")
    expect(html).toContain("type: 'error'")
    expect(html).toContain("type: 'expired'")
  })

  test('a site key containing a closing script tag cannot break out of the script', () => {
    const hostile = buildTurnstileDocument({ siteKey: '</script><script>alert(1)</script>', action: '</SCRIPT>' })

    expect(hostile.match(/<\/script>/gi)).toHaveLength(2)
    expect(hostile).toContain('\\u003c/script>')
  })
})

describe('parseTurnstileMessage', () => {
  test('accepts the three valid shapes', () => {
    expect(parseTurnstileMessage('{"type":"token","token":"abc"}')).toEqual({ kind: 'token', token: 'abc' })
    expect(parseTurnstileMessage('{"type":"error","code":"110200"}')).toEqual({ kind: 'error', code: '110200' })
    expect(parseTurnstileMessage('{"type":"expired"}')).toEqual({ kind: 'expired' })
  })

  test('returns null for invalid JSON, wrong types, an empty token, and non-string input', () => {
    expect(parseTurnstileMessage('not json')).toBeNull()
    expect(parseTurnstileMessage('null')).toBeNull()
    expect(parseTurnstileMessage('{"type":"token","token":42}')).toBeNull()
    expect(parseTurnstileMessage('{"type":"token","token":""}')).toBeNull()
    expect(parseTurnstileMessage('{"type":"error","code":7}')).toBeNull()
    expect(parseTurnstileMessage('{"type":"other"}')).toBeNull()
    expect(parseTurnstileMessage({ type: 'expired' })).toBeNull()
    expect(parseTurnstileMessage(undefined)).toBeNull()
  })
})
