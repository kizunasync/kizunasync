/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { createCaptchaGate } from './captcha-gate'

describe('createCaptchaGate', () => {
  test('is not pending initially', () => {
    const gate = createCaptchaGate()

    expect(gate.isPending()).toBe(false)
  })

  test('request marks the gate pending and returns the same promise on repeat', () => {
    const gate = createCaptchaGate()
    const first = gate.request()

    expect(gate.isPending()).toBe(true)
    const second = gate.request()

    expect(second).toBe(first)
  })

  test('resolve(null) keeps the gate pending', () => {
    const gate = createCaptchaGate()

    gate.request()
    gate.resolve(null)
    expect(gate.isPending()).toBe(true)
  })

  test('resolve(token) settles the promise and clears pending', async () => {
    const gate = createCaptchaGate()
    const promise = gate.request()

    gate.resolve('a-token')
    expect(gate.isPending()).toBe(false)
    expect(await promise).toBe('a-token')
  })

  test('resolve while not pending is a no-op', () => {
    const gate = createCaptchaGate()

    gate.resolve('a-token')
    expect(gate.isPending()).toBe(false)
  })

  test('subscribers are notified when request starts a challenge and when resolve settles it', () => {
    const gate = createCaptchaGate()
    let notifications = 0
    const unsubscribe = gate.subscribe(() => {
      notifications += 1
    })

    gate.request()
    expect(notifications).toBe(1)

    gate.resolve('a-token')
    expect(notifications).toBe(2)

    unsubscribe()
  })

  test('resolve(null) does not notify subscribers: no transition happened', () => {
    const gate = createCaptchaGate()

    gate.request()
    let notifications = 0

    gate.subscribe(() => {
      notifications += 1
    })

    gate.resolve(null)
    expect(notifications).toBe(0)
  })

  test('unsubscribe stops further notifications', () => {
    const gate = createCaptchaGate()
    let notifications = 0
    const unsubscribe = gate.subscribe(() => {
      notifications += 1
    })

    unsubscribe()

    gate.request()
    expect(notifications).toBe(0)
  })
})
