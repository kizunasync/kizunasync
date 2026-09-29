'use client'

import { useLayoutEffect, type RefObject } from 'react'

/** Publishes the chrome block's live height as `--reference-nav-chrome-h` on the nav element, so sticky section headings below it can offset by that exact height. */
export function useNavChromeHeight(navRef: RefObject<HTMLElement | null>, chromeRef: RefObject<HTMLDivElement | null>): void {
  useLayoutEffect(() => {
    const nav = navRef.current
    const chrome = chromeRef.current

    if (nav === null || chrome === null) {
      return
    }

    const syncChromeHeight = () => {
      nav.style.setProperty('--reference-nav-chrome-h', `${chrome.offsetHeight}px`)
    }

    syncChromeHeight()
    const observer = new ResizeObserver(syncChromeHeight)

    observer.observe(chrome)

    return () => observer.disconnect()
  }, [])
}
