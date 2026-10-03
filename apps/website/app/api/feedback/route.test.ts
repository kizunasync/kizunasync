import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resetRateLimitForTests } from '@/lib/rate-limit'
import { POST } from './route'

// MARK: - Helpers

const ENV_KEYS = [
  'WEBSITE_CLICKUP_API_TOKEN',
  'WEBSITE_CLICKUP_CONTACT_LIST_ID',
  'WEBSITE_CLICKUP_WORKSPACE_ID',
  'WEBSITE_CLICKUP_CONTACT_CHANNEL_ID',
  'WEBSITE_TURNSTILE_SECRET_KEY',
] as const

function clearFeedbackEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key]
  }
}

function configureClickUpTask(): void {
  process.env.WEBSITE_CLICKUP_API_TOKEN = 'test-token'
  process.env.WEBSITE_CLICKUP_CONTACT_LIST_ID = 'test-list-id'
}

function configureClickUpChat(): void {
  process.env.WEBSITE_CLICKUP_WORKSPACE_ID = 'test-workspace-id'
  process.env.WEBSITE_CLICKUP_CONTACT_CHANNEL_ID = 'test-channel-id'
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reason: 'feedback',
    email: 'user@example.com',
    message: 'This is a perfectly valid feedback message body.',
    ...overrides,
  }
}

function makeRequest(body: unknown, ip = '203.0.113.1'): Request {
  return new Request('https://example.com/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify(body),
  })
}

function okFetchMock() {
  return mock(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: 'task-1' }), { status: 200 }),
  )
}

// MARK: - Tests

describe('POST /api/feedback', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    clearFeedbackEnv()
    resetRateLimitForTests()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    clearFeedbackEnv()
    resetRateLimitForTests()
  })

  test('returns 503 when ClickUp is not configured', async () => {
    const response = await POST(makeRequest(validBody()))

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'not_configured' })
  })

  test('returns 400 for a schema-invalid body', async () => {
    configureClickUpTask()
    const response = await POST(
      makeRequest({ reason: 'not-a-real-reason', email: 'not-an-email', message: 'short' }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_body' })
  })

  test('returns 400 for malformed JSON', async () => {
    configureClickUpTask()
    const request = new Request('https://example.com/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.1' },
      body: 'not json',
    })
    const response = await POST(request)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_body' })
  })

  test('returns 429 after exceeding the per-IP limit within the window', async () => {
    configureClickUpTask()
    globalThis.fetch = okFetchMock() as unknown as typeof fetch
    const ip = '198.51.100.42'

    for (let i = 0; i < 5; i += 1) {
      const response = await POST(makeRequest(validBody(), ip))

      expect(response.status).toBe(200)
    }

    const sixth = await POST(makeRequest(validBody(), ip))

    expect(sixth.status).toBe(429)
    expect(await sixth.json()).toEqual({ error: 'rate_limited' })
  })

  test('returns 403 when Turnstile is configured and the token is invalid', async () => {
    configureClickUpTask()
    process.env.WEBSITE_TURNSTILE_SECRET_KEY = 'test-secret'
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      if (String(input).includes('turnstile')) {
        return new Response(JSON.stringify({ success: false }), { status: 200 })
      }
      return new Response(JSON.stringify({ id: 'task-1' }), { status: 200 })
    })

    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await POST(
      makeRequest(validBody({ turnstileToken: 'bad-token' }), '198.51.100.7'),
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'captcha_failed' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('returns 403 when Turnstile is configured and no token was sent', async () => {
    configureClickUpTask()
    process.env.WEBSITE_TURNSTILE_SECRET_KEY = 'test-secret'
    const fetchMock = mock(async () => new Response(JSON.stringify({ id: 'task-1' }), { status: 200 }))

    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await POST(makeRequest(validBody(), '198.51.100.8'))

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'captcha_failed' })
    // Empty-token short-circuits before any network call; the siteverify endpoint is never hit, so only a fetch from the (skipped) ClickUp step could have fired, and this path never reaches it either.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('returns 200 and calls both the ClickUp task and chat endpoints', async () => {
    configureClickUpTask()
    configureClickUpChat()
    const fetchMock = okFetchMock()

    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await POST(makeRequest(validBody({ area: 'cli', version: '0.3.1' })))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const urls = fetchMock.mock.calls.map(([input]) => String(input))

    expect(urls.some((url) => url.includes('/list/test-list-id/task'))).toBe(true)
    expect(
      urls.some((url) => url.includes('/workspaces/test-workspace-id/chat/channels/test-channel-id/messages')),
    ).toBe(true)
  })

  test('returns 502 when the ClickUp task creation fails', async () => {
    configureClickUpTask()
    const fetchMock = mock(async () => new Response('nope', { status: 500 }))

    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await POST(makeRequest(validBody(), '198.51.100.20'))

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'send_failed' })
  })

  test('returns 429 once the global limit is exceeded across many IPs', async () => {
    configureClickUpTask()
    globalThis.fetch = okFetchMock() as unknown as typeof fetch

    // GLOBAL_LIMIT is 100/60s (route.ts); one unique IP per request so the per-IP gate (5/60s) never trips and only the global bucket is exercised.
    for (let i = 0; i < 100; i += 1) {
      const response = await POST(makeRequest(validBody(), `10.0.0.${i}`))

      expect(response.status).toBe(200)
    }

    const overLimit = await POST(makeRequest(validBody(), '10.0.1.0'))

    expect(overLimit.status).toBe(429)
    expect(await overLimit.json()).toEqual({ error: 'rate_limited' })
  })

  test('a failed captcha never consumes the global rate-limit bucket', async () => {
    configureClickUpTask()
    process.env.WEBSITE_TURNSTILE_SECRET_KEY = 'test-secret'

    // Missing token fails the captcha check before any global-bucket consume (per the guard ordering in route.ts). Send well over GLOBAL_LIMIT (100) of these from unique IPs; if the ordering ever regressed to consume the global bucket before the captcha check, the bucket would already be exhausted by the time the legitimate request below is sent.
    for (let i = 0; i < 120; i += 1) {
      const response = await POST(makeRequest(validBody(), `172.16.0.${i}`))

      expect(response.status).toBe(403)
    }

    delete process.env.WEBSITE_TURNSTILE_SECRET_KEY
    globalThis.fetch = okFetchMock() as unknown as typeof fetch

    const finalResponse = await POST(makeRequest(validBody(), '172.16.1.1'))

    expect(finalResponse.status).toBe(200)
    expect(await finalResponse.json()).toEqual({ ok: true })
  })
})
