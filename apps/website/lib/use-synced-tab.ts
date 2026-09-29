'use client'

/**
 * Shared persistence for docs and marketing tab groups. `groupId` namespaces
 * localStorage (`kizunasync-docs-tab:<groupId>`), the CustomEvent, and the URL query
 * param so framework tabs and package-manager tabs never cross-sync.
 */

import { useEffect, useState } from 'react'

// MARK: - useSyncedTab

const DEFAULT_GROUP_ID = 'framework'
const FRAMEWORK_TAB_ALIASES: Record<string, string> = {
  Expo: 'Expo/React Native',
  'React Native': 'Expo/React Native',
  Vanilla: 'Vanilla / other',
}

const storageKeyFor = (groupId: string): string => `kizunasync-docs-tab:${groupId}`
const syncEventFor = (groupId: string): string => `kizunasync-tab-sync:${groupId}`

function resolveTabLabel(groupId: string, candidate: string | null, labels: readonly string[]): string | undefined {
  if (candidate === null) {
    return undefined
  }
  if (labels.includes(candidate)) {
    return candidate
  }
  if (groupId === DEFAULT_GROUP_ID) {
    const aliased = FRAMEWORK_TAB_ALIASES[candidate]

    if (aliased !== undefined && labels.includes(aliased)) {
      return aliased
    }
  }
  return undefined
}

export function useSyncedTab(groupId: string, labels: readonly string[]): [string, (label: string) => void] {
  const [active, setActive] = useState(labels[0] ?? '')

  useEffect(() => {
    const storageKey = storageKeyFor(groupId)
    const fromUrl = new URLSearchParams(window.location.search).get(groupId)
    const fromStorage = localStorage.getItem(storageKey)
    const resolved = [fromUrl, fromStorage]
      .map((candidate) => resolveTabLabel(groupId, candidate, labels))
      .find((label): label is string => label !== undefined)

    if (resolved !== undefined) {
      setActive(resolved)
    }
    const syncEvent = syncEventFor(groupId)
    const onSync = (event: Event): void => {
      const mapped = resolveTabLabel(groupId, (event as CustomEvent<string>).detail, labels)

      if (mapped !== undefined) {
        setActive(mapped)
      }
    }
    window.addEventListener(syncEvent, onSync)

    return () => window.removeEventListener(syncEvent, onSync)
  }, [groupId, labels])

  const pick = (label: string): void => {
    setActive(label)
    localStorage.setItem(storageKeyFor(groupId), label)
    const url = new URL(window.location.href)

    url.searchParams.set(groupId, label)
    window.history.replaceState(window.history.state, '', url)
    window.dispatchEvent(new CustomEvent(syncEventFor(groupId), { detail: label }))
  }

  return [active, pick]
}
