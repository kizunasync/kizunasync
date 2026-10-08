import { describe, expect, test } from 'bun:test'
import { placeTip } from '@/lib/place-tip'

const viewport = { width: 375, height: 667 }
const panel = { width: 280, height: 120 }

describe('placeTip', () => {
  test('places the panel under the trigger, centered', () => {
    expect(placeTip({ trigger: { top: 100, left: 150, width: 40, height: 24 }, panel, viewport, gap: 8 })).toEqual({ top: 132, left: 30 })
  })

  test('clamps to the right edge with an 8 px margin', () => {
    expect(placeTip({ trigger: { top: 100, left: 340, width: 30, height: 24 }, panel, viewport, gap: 8 }).left).toBe(87)
  })

  test('clamps to the left edge', () => {
    expect(placeTip({ trigger: { top: 100, left: 0, width: 30, height: 24 }, panel, viewport, gap: 8 }).left).toBe(8)
  })

  test('flips above the trigger when there is no room below', () => {
    expect(placeTip({ trigger: { top: 600, left: 150, width: 40, height: 24 }, panel, viewport, gap: 8 }).top).toBe(472)
  })
})
