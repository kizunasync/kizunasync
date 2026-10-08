'use client'

import { useEffect } from 'react'
import { activeSectionId, hashForSection, isSamePageHashLink, stickyReadLine } from './section-hash'

interface ISectionHashOptions {
  rootSelector?: string

  /** The section that keeps a bare URL; `hashForSection` defaults it to the home hero. */
  bareSectionId?: string
}

/** Quiet period that ends a fragment jump when no `scrollend` arrives, for example a jump that finished before hydration. */
const SETTLE_IDLE_MS = 150

/**
 * Keeps the URL fragment in lockstep with the `section[id]` currently
 * at the read line. Uses replaceState so scrolling does not pollute history.
 * While the browser animates to a fragment (a deep link like `/#faq`, an
 * in-page anchor click, or a hashchange) the hook is settling: its scroll
 * events pass over other sections, so they never write the URL, and the
 * target fragment stays once the scroll ends (`scrollend`, or a short quiet
 * period).
 */
export function useSectionHash({ rootSelector = '#main-content', bareSectionId }: ISectionHashOptions = {}): void {
  useEffect(() => {
    const root = document.querySelector(rootSelector)

    if (root === null) {
      return
    }

    let raf = 0
    let settleTimer = 0
    let armed = window.location.hash === ''
    let settling = false

    const measure = () => {
      if (armed) {
        writeActiveHash(root, bareSectionId)
      }
    }

    const finishSettling = () => {
      window.clearTimeout(settleTimer)

      if (settling) {
        settling = false
        armed = true
      }
    }

    const restartSettleTimer = () => {
      window.clearTimeout(settleTimer)
      settleTimer = window.setTimeout(finishSettling, SETTLE_IDLE_MS)
    }

    const settle = () => {
      settling = true
      cancelAnimationFrame(raf)
      restartSettleTimer()
    }

    const onScroll = () => {
      if (settling) {
        restartSettleTimer()

        return
      }
      armed = true
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }

    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href*="#"]') : null

      if (link !== null && isSamePageHashLink(link.href, window.location.href)) {
        settle()
      }
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    window.addEventListener('scrollend', finishSettling)
    window.addEventListener('hashchange', settle)
    document.addEventListener('click', onClick, true)
    const observer = new ResizeObserver(onScroll)

    observer.observe(root)

    if (armed) {
      measure()
    } else {
      settle()
    }

    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(settleTimer)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('scrollend', finishSettling)
      window.removeEventListener('hashchange', settle)
      document.removeEventListener('click', onClick, true)
      observer.disconnect()
    }
  }, [rootSelector, bareSectionId])
}

// MARK: - Helpers

/** Points the URL fragment at the last `section[id]` under `root` whose top has crossed the read line. */
function writeActiveHash(root: Element, bareSectionId: string | undefined): void {
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
  const hash = hashForSection(id, bareSectionId)

  if (window.location.hash === hash) {
    return
  }
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${hash}`)
}
