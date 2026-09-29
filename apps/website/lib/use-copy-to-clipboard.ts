'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// MARK: - useCopyToClipboard

export function useCopyToClipboard(resetAfterMs = 1800): { copied: boolean; copy: (text: string) => Promise<void> } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), resetAfterMs)
      } catch {
        // Clipboard unavailable (permissions/insecure context); ignore.
      }
    },
    [resetAfterMs],
  )

  useEffect(() => () => clearTimeout(timer.current), [])

  return { copied, copy }
}
