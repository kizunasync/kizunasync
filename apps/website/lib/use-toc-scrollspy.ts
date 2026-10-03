'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import type { IHeading } from '@/lib/docs'

export interface IUseTocScrollspyResult {
  activeId: string | null
  railRef: RefObject<HTMLDivElement | null>
  registerLink: (id: string, node: HTMLAnchorElement | null) => void
}

/**
 * Single-active-heading scrollspy (classic fumadocs/Supabase margins) with
 * edge handling so the first/last items activate at the page extremes, plus
 * the rail position sync that drives the `--toc-top`/`--toc-height` thumb.
 */
export function useTocScrollspy(headings: IHeading[]): IUseTocScrollspyResult {
  const [activeId, setActiveId] = useState<string | null>(headings[0]?.id ?? null)
  const railRef = useRef<HTMLDivElement>(null)
  const linkRefs = useRef(new Map<string, HTMLAnchorElement>())

  useEffect(() => {
    const elements = headings
      .map((heading) => document.getElementById(heading.id))
      .filter((element): element is HTMLElement => element !== null)

    if (elements.length === 0) {
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id)
          }
        }
      },
      { rootMargin: '-80px 0% -70% 0%', threshold: 1 },
    )

    for (const element of elements) {
      observer.observe(element)
    }

    const onScroll = () => {
      if (window.scrollY < 80) {
        setActiveId(elements[0]?.id ?? null)
      } else if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 8) {
        setActiveId(elements[elements.length - 1]?.id ?? null)
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', onScroll)
    }
  }, [headings])

  useEffect(() => {
    const rail = railRef.current
    const link = activeId !== null ? linkRefs.current.get(activeId) : undefined

    if (rail === null || link === undefined) {
      return
    }
    const update = () => {
      rail.style.setProperty('--toc-top', `${link.offsetTop}px`)
      rail.style.setProperty('--toc-height', `${link.offsetHeight}px`)
    }
    update()
    const observer = new ResizeObserver(update)

    observer.observe(rail)

    return () => observer.disconnect()
  }, [activeId])

  const registerLink = (id: string, node: HTMLAnchorElement | null) => {
    if (node !== null) {
      linkRefs.current.set(id, node)
    } else {
      linkRefs.current.delete(id)
    }
  }

  return { activeId, railRef, registerLink }
}
