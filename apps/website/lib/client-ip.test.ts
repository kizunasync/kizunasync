import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { clientIp } from './client-ip'

// MARK: - Helpers

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request('https://example.com/api/feedback', { headers })
}

// MARK: - Tests

describe('clientIp', () => {
  const originalTrustFlag = process.env.WEBSITE_TRUST_PROXY_HEADERS

  beforeEach(() => {
    delete process.env.WEBSITE_TRUST_PROXY_HEADERS
  })

  afterEach(() => {
    if (originalTrustFlag === undefined) {
      delete process.env.WEBSITE_TRUST_PROXY_HEADERS
    } else {
      process.env.WEBSITE_TRUST_PROXY_HEADERS = originalTrustFlag
    }
  })

  test('returns x-real-ip when present', () => {
    expect(clientIp(requestWithHeaders({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9')
  })

  test('trims whitespace around x-real-ip', () => {
    expect(clientIp(requestWithHeaders({ 'x-real-ip': '  203.0.113.9  ' }))).toBe('203.0.113.9')
  })

  test('falls back to the rightmost x-forwarded-for hop', () => {
    const request = requestWithHeaders({
      'x-forwarded-for': '203.0.113.1, 198.51.100.2, 192.0.2.3',
    })

    expect(clientIp(request)).toBe('192.0.2.3')
  })

  test('ignores empty hops in x-forwarded-for', () => {
    const request = requestWithHeaders({ 'x-forwarded-for': '203.0.113.1, ,198.51.100.2,' })

    expect(clientIp(request)).toBe('198.51.100.2')
  })

  test('prefers x-real-ip over x-forwarded-for', () => {
    const request = requestWithHeaders({
      'x-real-ip': '203.0.113.9',
      'x-forwarded-for': '198.51.100.2',
    })

    expect(clientIp(request)).toBe('203.0.113.9')
  })

  test('falls back to local with no headers', () => {
    expect(clientIp(requestWithHeaders({}))).toBe('local')
  })

  test('collapses to local when proxy headers are untrusted', () => {
    process.env.WEBSITE_TRUST_PROXY_HEADERS = 'false'
    const request = requestWithHeaders({ 'x-real-ip': '203.0.113.9' })

    expect(clientIp(request)).toBe('local')
  })
})
