'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { usePathname } from 'next/navigation'
import { HEADER_BAR_SLOT_ID } from './site-header'

// MARK: - DocsMobileBar

/**
 * The docs nav ATTACHES to the main floating header on mobile: a slim bar is
 * portaled into the header pill's slot (same glass surface, so it can never
 * detach), and opens a left drawer with the full grouped nav (the Supabase
 * docs pattern). Hidden at lg+ where the real sidebar exists.
 */
export function DocsMobileBar({
  items,
  children,
}: {
  items: Array<{ href: string; title: string }>
  children: ReactNode
}) {
  // MARK: - Variables
  const pathname = usePathname()
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)

  const current = items.find((item) => item.href === pathname)

  // MARK: - Lifecycle

  useEffect(() => {
    setSlot(document.getElementById(HEADER_BAR_SLOT_ID))
  }, [])

  useEffect(() => {
    setOpen(false)
  }, [pathname])

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    const onResize = () => {
      if (window.innerWidth >= 1024) {
        setOpen(false)
      }
    }
    window.addEventListener('resize', onResize)

    return () => {
      document.body.style.overflow = ''
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  if (slot === null) {
    return null
  }

  // MARK: - Render

  return (
    <>
      {createPortal(
        <div className="border-site-border/60 border-t lg:hidden">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-sm sm:px-6"
          >
            <span className="text-site-accent" aria-hidden="true">
              {open ? '✕' : '☰'}
            </span>
            <span className="text-site-muted">Docs</span>
            {current !== undefined ? (
              <>
                <span className="text-site-faint" aria-hidden="true">
                  /
                </span>
                <span className="truncate font-medium">{current.title}</span>
              </>
            ) : null}
          </button>
        </div>,
        slot,
      )}

      {open
        ? createPortal(
            <div className="fixed inset-0 z-40 lg:hidden">
              <button
                type="button"
                aria-label="Close documentation menu"
                onClick={() => setOpen(false)}
                className="mobile-menu absolute inset-0 backdrop-blur-sm"
              />
              <div className="border-site-border bg-site-background absolute inset-y-0 left-0 w-3/4 max-w-xs overflow-y-auto border-r p-5 pt-24 shadow-2xl">
                {children}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
