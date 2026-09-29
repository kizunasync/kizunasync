/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { buildPacketTimeline, type TPacketTimeline } from './scene-packet-timeline'

/** Records every `set`/`to` call instead of animating anything; `TGsap` only needs `timeline()` for this module. */
function fakeGsap(): { timeline: () => TPacketTimeline; calls: Array<{ method: 'set' | 'to'; vars: Record<string, unknown> }> } {
  const calls: Array<{ method: 'set' | 'to'; vars: Record<string, unknown> }> = []
  const fakeTimeline = {
    set: (_target: unknown, vars: Record<string, unknown>) => {
      calls.push({ method: 'set', vars })

      return fakeTimeline
    },
    to: (_target: unknown, vars: Record<string, unknown>) => {
      calls.push({ method: 'to', vars })

      return fakeTimeline
    },
    pause: () => fakeTimeline,
    restart: () => fakeTimeline,
    kill: () => fakeTimeline,
  }

  return { timeline: () => fakeTimeline as unknown as TPacketTimeline, calls }
}

function fakeScene(width: number, cardHeight: number): HTMLDivElement {
  return {
    getBoundingClientRect: () => ({ width }) as DOMRect,
    querySelector: () => ({ getBoundingClientRect: () => ({ height: cardHeight }) as DOMRect }),
  } as unknown as HTMLDivElement
}

describe('buildPacketTimeline', () => {
  test('lays out every packet: 1 set (initial placement) + 5 to (fade in, 3-point path, fade out) each', () => {
    const gsap = fakeGsap()
    const packets = [{}, {}] as unknown as HTMLSpanElement[]
    const packetTimelineRef = { current: null } as { current: TPacketTimeline | null }

    buildPacketTimeline({
      gsap: gsap as unknown as Parameters<typeof buildPacketTimeline>[0]['gsap'],
      scene: fakeScene(800, 104),
      packets,
      packetTimelineRef,
      isOffline: () => false,
    })

    expect(gsap.calls.filter((call) => call.method === 'set')).toHaveLength(2)
    expect(gsap.calls.filter((call) => call.method === 'to')).toHaveLength(10)
  })

  test('kills the previous timeline before building the next one', () => {
    const gsap = fakeGsap()
    let killed = false
    const previous = { kill: () => (killed = true) } as unknown as TPacketTimeline
    const packetTimelineRef = { current: previous }

    buildPacketTimeline({
      gsap: gsap as unknown as Parameters<typeof buildPacketTimeline>[0]['gsap'],
      scene: fakeScene(800, 104),
      packets: [{}] as unknown as HTMLSpanElement[],
      packetTimelineRef,
      isOffline: () => false,
    })

    expect(killed).toBe(true)
    expect(packetTimelineRef.current).not.toBe(previous)
  })

  test('pauses immediately when the scene is currently offline', () => {
    const gsap = fakeGsap()
    let paused = false
    const packetTimelineRef = { current: null } as { current: TPacketTimeline | null }
    const realTimeline = gsap.timeline()

    gsap.timeline = () => {
      const withPause = { ...realTimeline, pause: () => (paused = true) }

      return withPause as unknown as TPacketTimeline
    }

    buildPacketTimeline({
      gsap: gsap as unknown as Parameters<typeof buildPacketTimeline>[0]['gsap'],
      scene: fakeScene(800, 104),
      packets: [{}] as unknown as HTMLSpanElement[],
      packetTimelineRef,
      isOffline: () => true,
    })

    expect(paused).toBe(true)
  })

  test('an even-indexed (forward) packet starts at the first path point; an odd-indexed (reverse) packet starts at the last', () => {
    const gsap = fakeGsap()
    const packetTimelineRef = { current: null } as { current: TPacketTimeline | null }

    buildPacketTimeline({
      gsap: gsap as unknown as Parameters<typeof buildPacketTimeline>[0]['gsap'],
      scene: fakeScene(1000, 100),
      packets: [{}, {}] as unknown as HTMLSpanElement[],
      packetTimelineRef,
      isOffline: () => false,
    })

    const setCalls = gsap.calls.filter((call) => call.method === 'set')

    expect(setCalls[0]?.vars.x).toBe(1000 * 0.08)
    expect(setCalls[1]?.vars.x).toBe(1000 * 0.9)
  })
})
