'use client'

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { SUPABASE_GREEN, type IFramework } from '@/lib/frameworks'
import { buildPacketTimeline, type TPacketTimeline } from '@/lib/scene-packet-timeline'

const FIRST_OFFLINE_MS = 4200
const ONLINE_MS = 5800
const OFFLINE_MS = 9200

export type TSceneStyle = CSSProperties & {
  '--scene-local-color': string
  '--scene-remote-color': string
}

export interface IUseSyncSceneResult {
  offline: boolean
  reconnectBurst: number
  sceneRef: RefObject<HTMLDivElement | null>
  packetRefs: RefObject<Array<HTMLSpanElement | null>>
  sceneStyle: TSceneStyle
}

/**
 * Owns the offline/online cycle timer and the GSAP packet timeline between
 * SQLite and Supabase (built by `buildPacketTimeline`). Both effects return
 * early under reduced motion, so the scene is static and the stylesheet hides
 * the packet layer.
 */
export function useSyncScene(framework: IFramework): IUseSyncSceneResult {
  const [offline, setOffline] = useState(false)
  const [reconnectBurst, setReconnectBurst] = useState(0)
  const sceneRef = useRef<HTMLDivElement>(null)
  const offlineRef = useRef(false)
  const packetRefs = useRef<Array<HTMLSpanElement | null>>([])
  const packetTimelineRef = useRef<TPacketTimeline | null>(null)
  const sceneStyle: TSceneStyle = {
    '--scene-local-color': framework.color,
    '--scene-remote-color': SUPABASE_GREEN,
  }

  offlineRef.current = offline

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return
    }

    let alive = true
    let timer: ReturnType<typeof setTimeout>

    const goOnline = () => {
      if (!alive) {
        return
      }
      setOffline(false)
      setReconnectBurst((burst) => burst + 1)
      timer = setTimeout(goOffline, ONLINE_MS)
    }

    const goOffline = () => {
      if (!alive) {
        return
      }
      setOffline(true)
      timer = setTimeout(goOnline, OFFLINE_MS)
    }

    timer = setTimeout(goOffline, FIRST_OFFLINE_MS)

    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return
    }

    let alive = true
    let cleanup: (() => void) | undefined

    void import('gsap').then(({ gsap }) => {
      if (!alive || sceneRef.current === null) {
        return
      }

      const scene = sceneRef.current
      const packets = packetRefs.current.filter(Boolean) as HTMLSpanElement[]
      const rebuild = () =>
        buildPacketTimeline({ gsap, scene, packets, packetTimelineRef, isOffline: () => offlineRef.current })

      rebuild()
      window.addEventListener('resize', rebuild)
      cleanup = () => {
        window.removeEventListener('resize', rebuild)
        packetTimelineRef.current?.kill()
        packetTimelineRef.current = null
      }
    })

    return () => {
      alive = false
      cleanup?.()
    }
  }, [])

  useEffect(() => {
    const timeline = packetTimelineRef.current

    if (timeline === null) {
      return
    }

    if (offline) {
      timeline.pause(0)
    } else {
      timeline.restart()
    }
  }, [offline])

  return { offline, reconnectBurst, sceneRef, packetRefs, sceneStyle }
}
