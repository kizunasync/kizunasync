/// <reference types="bun" />
import { describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import * as demoConfig from '../runtime/demo-config'
import { createCaptchaGate, type ICaptchaGate } from '@kizunasync/utilities'

// Bun does not read the `@/` alias from tsconfig.app.json, so the module captcha-gate.tsx imports through it resolves to the real one.
mock.module('@/runtime/demo-config', () => demoConfig)

const { CaptchaGate } = await import('./captcha-gate')

const DEMO_MARKUP = '<p>Demo</p>'
const INERT_DEMO_MARKUP = `<div inert="">${DEMO_MARKUP}</div>`

const renderGate = (gate: ICaptchaGate): string =>
  renderToStaticMarkup(
    <CaptchaGate gate={gate} siteKey="site-key">
      <p>Demo</p>
    </CaptchaGate>,
  )

const createPendingGate = (): ICaptchaGate => {
  const gate = createCaptchaGate()

  void gate.request()

  return gate
}

const readAttribute = (markup: string, name: string): string => markup.match(new RegExp(`${name}="([^"]+)"`))?.[1] ?? ''

const readTextById = (markup: string, id: string): string => {
  const attributeAt = markup.indexOf(`id="${id}"`)

  if (id === '' || attributeAt < 0) {
    return ''
  }
  const contentStart = markup.indexOf('>', attributeAt) + 1

  return markup.slice(contentStart, markup.indexOf('</', contentStart))
}

describe('CaptchaGate', () => {
  test('pending renders a modal dialog labelled by its title and described by its text', () => {
    const markup = renderGate(createPendingGate())

    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-modal="true"')
    expect(readTextById(markup, readAttribute(markup, 'aria-labelledby'))).toBe('Start the demo')
    expect(readTextById(markup, readAttribute(markup, 'aria-describedby'))).toBe(
      'Cloudflare Turnstile checks once per visitor that you are human.',
    )
  })

  test('pending keeps the demo rendering in an inert root and puts the dialog outside it', () => {
    const markup = renderGate(createPendingGate())

    expect(markup).toStartWith(INERT_DEMO_MARKUP)
    expect(markup.indexOf('role="dialog"')).toBeGreaterThan(INERT_DEMO_MARKUP.length)
  })

  test('resolved renders the demo alone, interactive and without a dialog', () => {
    const gate = createPendingGate()

    gate.resolve('a-token')
    expect(renderGate(gate)).toBe(`<div>${DEMO_MARKUP}</div>`)
  })

  test('a gate that never asked for a token renders the demo alone', () => {
    expect(renderGate(createCaptchaGate())).toBe(`<div>${DEMO_MARKUP}</div>`)
  })
})
