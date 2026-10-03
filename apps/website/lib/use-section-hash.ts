'use client'

import { useEffect } from 'react'
import { activeSectionId, hashForSection, stickyReadLine } from './section-hash'

/**
 * Keeps the landing URL fragment in lockstep with the `section[id]` currently
 * at the read line. Uses replaceState so scrolling does not pollute history,
 * and waits for the first scroll so a deep link like `/#faq` is not overwritten
 * before the browser has jumped to it.
 */
export function useSectionHash(rootSelector = '#main-content'): void {
  useEffect(() => {
    const root = document.querySelector(rootSelector)

    if (root === null) {
      return
    }

    let raf = 0
    let armed = window.location.hash === ''

    const measure = () => {
      if (!armed) {
        return
      }
      const nav = document.querySelector<HTMLElement>('.sticky.top-20')
      const navRect = nav?.getBoundingClientRect()
      const readLine = stickyReadLine(navRect?.top ?? null, navRect?.bottom ?? null)
      const sections = [...root.querySelectorAll<HTMLElement>('section[id]')].map((section) => ({
        id: section.id,
        top: section.getBoundingClientRect().top,
      }))
      const id = activeSectionId(sections, readLine)

      if (id === null) {
        return
      }
      const hash = hashForSection(id)

      if (window.location.hash === hash) {
        return
      }
      const next = `${window.location.pathname}${window.location.search}${hash}`

      window.history.replaceState(window.history.state, '', next)
    }

    const onScroll = () => {
      armed = true
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    const observer = new ResizeObserver(onScroll)

    observer.observe(root)

    if (armed) {
      measure()
    }

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      observer.disconnect()
    }
  }, [rootSelector])
}
