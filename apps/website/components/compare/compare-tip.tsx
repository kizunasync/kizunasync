'use client'

/**
 * Toggletip for the compare matrix. The panel is always in the server HTML (hidden until
 * opened), so crawlers, no-JavaScript visitors, and screen readers through aria-describedby
 * all get its text. It is `position: fixed` so it escapes the table's scroll box, which also
 * means no ancestor may carry a transform.
 */

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { placeTip } from '@/lib/place-tip'

// MARK: - Constants

const OPEN_DELAY_MS = 120
const CLOSE_DELAY_MS = 160
const PANEL_GAP_PX = 8

// MARK: - CompareTip

export const TipPinnedContext = createContext(false)

/** Focusable content inside a tip joins the Tab order only while the tip is pinned. */
export const useTipPinned = (): boolean => useContext(TipPinnedContext)

export function CompareTip({ id, label, children }: { id: string; label: ReactNode; children: ReactNode }) {
  const tip = useToggletip()

  return (
    <div
      ref={tip.rootRef}
      className="contents"
      onPointerEnter={tip.handlePointerEnter}
      onPointerLeave={tip.handlePointerLeave}
      onBlur={tip.handleBlur}
    >
      <button
        ref={tip.triggerRef}
        type="button"
        aria-expanded={tip.isOpen}
        aria-controls={id}
        aria-describedby={id}
        onFocus={tip.open}
        onClick={tip.toggle}
        className="group cursor-pointer rounded-md text-left"
      >
        {label}
      </button>
      <div
        ref={tip.panelRef}
        id={id}
        hidden={!tip.isOpen}
        tabIndex={-1}
        className="border-site-border bg-site-raised text-site-text shadow-site-elevated fixed top-0 left-0 z-40 w-max max-w-[18rem] rounded-lg border px-3.5 py-3 text-left text-xs leading-relaxed font-normal motion-safe:transition-opacity motion-safe:duration-150 starting:opacity-0"
      >
        <TipPinnedContext.Provider value={tip.isPinned}>{children}</TipPinnedContext.Provider>
      </div>
    </div>
  )
}

// MARK: - Internal

const useToggletip = () => {
  const [isOpen, setIsOpen] = useState(false)
  const [isPinned, setIsPinned] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const open = () => {
    clearTimeout(timerRef.current)
    setIsOpen(true)
  }
  const close = () => {
    clearTimeout(timerRef.current)
    setIsOpen(false)
    setIsPinned(false)
  }
  const toggle = () => {
    if (isPinned) {
      close()

      return
    }
    open()
    setIsPinned(true)
  }
  const handlePointerEnter = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') {
      return
    }
    clearTimeout(timerRef.current)

    if (!isOpen) {
      timerRef.current = setTimeout(open, OPEN_DELAY_MS)
    }
  }
  const handlePointerLeave = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || isPinned) {
      return
    }
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(close, CLOSE_DELAY_MS)
  }
  const handleBlur = (event: FocusEvent) => {
    if (!isInside(rootRef.current, event.relatedTarget)) {
      close()
    }
  }

  useEffect(() => () => clearTimeout(timerRef.current), [])
  useDismiss({ isOpen, rootRef, triggerRef, close })
  usePanelPlacement({ isOpen, triggerRef, panelRef })

  return { isOpen, isPinned, rootRef, triggerRef, panelRef, open, toggle, handlePointerEnter, handlePointerLeave, handleBlur }
}

const useDismiss = ({ isOpen, rootRef, triggerRef, close }: { isOpen: boolean; rootRef: RefObject<HTMLDivElement | null>; triggerRef: RefObject<HTMLButtonElement | null>; close: () => void }) => {
  useEffect(() => {
    if (!isOpen) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }

      if (isInside(rootRef.current, document.activeElement)) {
        // Focusing the trigger reopens the tip through its focus handler, so the close that follows must be the last update.
        triggerRef.current?.focus()
      }
      close()
    }
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      if (!isInside(rootRef.current, event.target)) {
        close()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('pointerdown', handlePointerDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [isOpen, rootRef, triggerRef, close])
}

const usePanelPlacement = ({ isOpen, triggerRef, panelRef }: { isOpen: boolean; triggerRef: RefObject<HTMLButtonElement | null>; panelRef: RefObject<HTMLDivElement | null> }) => {
  useLayoutEffect(() => {
    const trigger = triggerRef.current
    const panel = panelRef.current

    if (!isOpen || trigger === null || panel === null) {
      return
    }

    const positionPanel = () => {
      const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }
      const { top, left } = placeTip({ trigger: trigger.getBoundingClientRect(), panel: { width: panel.offsetWidth, height: panel.offsetHeight }, viewport, gap: PANEL_GAP_PX })

      panel.style.top = `${top}px`
      panel.style.left = `${left}px`
    }

    positionPanel()
    window.addEventListener('scroll', positionPanel, { capture: true, passive: true })
    window.addEventListener('resize', positionPanel)

    return () => {
      window.removeEventListener('scroll', positionPanel, { capture: true })
      window.removeEventListener('resize', positionPanel)
    }
  }, [isOpen, triggerRef, panelRef])
}

function isInside(root: HTMLElement | null, target: EventTarget | null): boolean {
  return root !== null && target instanceof Node && root.contains(target)
}
