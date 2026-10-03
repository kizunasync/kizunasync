'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import { FRAMEWORKS, type IFramework } from '@/lib/frameworks'

const HOLD_SECONDS = 2.2
const TYPE_CPS = 18
const DELETE_CPS = 22

export interface IUseFrameworkTypewriterResult {
  framework: IFramework
  wordRef: RefObject<HTMLSpanElement | null>
  pauseFrameworkRotation: () => void
  resumeFrameworkRotation: () => void
}

/**
 * GSAP typewriter that cycles through FRAMEWORKS (Expo first), typing then
 * deleting each label at its own cps, holding for HOLD_SECONDS between. The
 * active framework also drives the tinted SQLite node in SyncScene.
 * Reduced motion / no JS: the ref's static textContent stays FRAMEWORKS[0].
 */
export function useFrameworkTypewriter(): IUseFrameworkTypewriterResult {
  const [index, setIndex] = useState(0)
  const wordRef = useRef<HTMLSpanElement>(null)
  const timelineRef = useRef<{
    kill: () => void
    pause: () => void
    resume: () => void
  } | null>(null)
  const framework = FRAMEWORKS[index % FRAMEWORKS.length] ?? FRAMEWORKS[0]!

  useEffect(() => {
    const node = wordRef.current

    if (node === null) {
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      node.textContent = FRAMEWORKS[0]!.label

      return
    }
    let alive = true
    let cleanup: (() => void) | undefined

    void import('gsap').then(({ gsap }) => {
      if (!alive) {
        return
      }
      const timeline = gsap.timeline({ repeat: -1 })

      timelineRef.current = timeline
      FRAMEWORKS.forEach((entry, frameworkIndex) => {
        const proxy = { chars: 0 }

        timeline.call(() => setIndex(frameworkIndex))
        timeline.to(proxy, {
          chars: entry.label.length,
          duration: entry.label.length / TYPE_CPS,
          ease: 'none',
          onUpdate: () => {
            node.textContent = entry.label.slice(0, Math.round(proxy.chars))
          },
        })
        timeline.to({}, { duration: HOLD_SECONDS })
        timeline.to(proxy, {
          chars: 0,
          duration: entry.label.length / DELETE_CPS,
          ease: 'none',
          onUpdate: () => {
            node.textContent = entry.label.slice(0, Math.round(proxy.chars))
          },
        })
      })
      cleanup = () => {
        timeline.kill()
        timelineRef.current = null
      }
    })

    return () => {
      alive = false
      cleanup?.()
    }
  }, [])

  return {
    framework,
    wordRef,
    pauseFrameworkRotation: () => timelineRef.current?.pause(),
    resumeFrameworkRotation: () => timelineRef.current?.resume(),
  }
}
