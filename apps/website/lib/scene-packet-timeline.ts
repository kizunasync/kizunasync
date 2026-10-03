import type { RefObject } from 'react'

type TGsapModule = typeof import('gsap')
type TGsap = TGsapModule['gsap']
export type TPacketTimeline = ReturnType<TGsap['timeline']>

/**
 * Lays out one packet along the 5-point path across the scene at `delay`
 * seconds into the loop; `reverse` walks the path backwards so alternating
 * packets visually cross (client→server vs server→client).
 */
function addPacket(params: {
  timeline: TPacketTimeline
  packet: HTMLSpanElement
  delay: number
  xs: number[]
  ys: number[]
  reverse: boolean
}): void {
  const { timeline, packet, delay, xs, ys, reverse } = params
  const pathX = reverse ? [...xs].reverse() : xs
  const pathY = reverse ? [...ys].reverse() : ys

  timeline.set(packet, { opacity: 0, scaleX: 0.55, x: pathX[0], y: pathY[0] }, delay)
  timeline.to(packet, { opacity: 0.95, duration: 0.18 }, delay + 0.05)
  timeline.to(packet, { x: pathX[1], y: pathY[1], scaleX: 1, duration: 0.58 }, delay + 0.1)
  timeline.to(packet, { x: pathX[2], y: pathY[2], duration: 0.58 }, delay + 0.68)
  timeline.to(packet, { x: pathX[3], y: pathY[3], duration: 0.58 }, delay + 1.26)
  timeline.to(packet, { x: pathX[4], y: pathY[4], opacity: 0, scaleX: 0.7, duration: 0.52 }, delay + 1.84)
}

/**
 * Rebuilds the repeating packet timeline from the scene's current layout;
 * call again on resize. Pauses immediately if the scene is currently offline,
 * so a rebuild during an offline window does not resume motion early.
 */
export function buildPacketTimeline(params: {
  gsap: TGsap
  scene: HTMLDivElement
  packets: HTMLSpanElement[]
  packetTimelineRef: RefObject<TPacketTimeline | null>
  isOffline: () => boolean
}): void {
  const { gsap, scene, packets, packetTimelineRef, isOffline } = params

  packetTimelineRef.current?.kill()

  const width = scene.getBoundingClientRect().width
  const cardHeight = scene.querySelector('.scene-card')?.getBoundingClientRect().height ?? 104
  const xs = [width * 0.08, width * 0.31, width * 0.52, width * 0.72, width * 0.9]
  const ys = [cardHeight * 0.7, cardHeight * 0.86, cardHeight * 0.72, cardHeight * 0.9, cardHeight * 0.74]
  const timeline = gsap.timeline({ repeat: -1, defaults: { ease: 'sine.inOut' } })

  packets.forEach((packet, index) => {
    addPacket({ timeline, packet, delay: index * 0.52, xs, ys, reverse: index % 2 === 1 })
  })

  packetTimelineRef.current = timeline

  if (isOffline()) {
    timeline.pause(0)
  }
}
