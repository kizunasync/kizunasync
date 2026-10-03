'use client'

import { useEffect, useState, type RefObject } from 'react'
import { sectionScrollProgress } from './journey-progress'

/**
 * Per-section 0 → 1 progress for the sticky journey nav. Each id is a page
 * section (`#cli`, `#api`, `#quickstart`); the read line is the nav's bottom
 * edge so a block fills only while its own section scrolls past it.
 */
export function useJourneyProgress(
  stepIds: readonly string[],
  readLineRef: RefObject<HTMLElement | null>,
): number[] {
  const [progresses, setProgresses] = useState(() => stepIds.map(() => 0))
  const idsKey = stepIds.join('\0')

  useEffect(() => {
    const ids = idsKey === '' ? [] : idsKey.split('\0')
    let raf = 0

    const measure = () => {
      const readLine = readLineRef.current?.getBoundingClientRect().bottom ?? 0
      const next = ids.map((id) => {
        const section = document.getElementById(id)

        if (section === null) {
          return 0
        }
        const rect = section.getBoundingClientRect()

        return sectionScrollProgress(rect.top, rect.height, readLine)
      })

      setProgresses((current) => {
        if (current.length === next.length && current.every((value, index) => value === next[index])) {
          return current
        }
        return next
      })
    }

    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }

    measure()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)

    const observer = new ResizeObserver(onScroll)

    for (const id of ids) {
      const section = document.getElementById(id)

      if (section !== null) {
        observer.observe(section)
      }
    }
    if (readLineRef.current !== null) {
      observer.observe(readLineRef.current)
    }

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      observer.disconnect()
    }
  }, [idsKey, readLineRef])

  return progresses
}
