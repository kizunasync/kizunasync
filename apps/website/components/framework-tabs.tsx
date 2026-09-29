'use client'

// MARK: - FrameworkTabs

/**
 * Supabase-style tab switcher for the docs, reused for two independent choices:
 * framework (React / Vue / Expo/React Native / Swift / Kotlin / Vanilla / other) and package manager (npm/pnpm/yarn/bun). Each
 * panel's code is highlighted server-side (Shiki) and rendered into the DOM
 * up-front, so every variant stays in the raw HTML for AI crawlers and SEO;
 * only visibility toggles client-side.
 *
 * `groupId` namespaces all three persistence channels so the two dimensions
 * never cross-sync: the localStorage key (`kizunasync-docs-tab:<groupId>`), the
 * window CustomEvent name, and the URL query param (named after `groupId`
 * itself, e.g. `?framework=` or `?pm=`). Every tab group sharing a `groupId`
 * on the page still syncs together and persists (localStorage + URL, URL
 * taking priority on load), mirroring Supabase's queryGroup behavior.
 * `groupId` defaults to 'framework', the group most panels on the site use.
 */

import { CopyCodeButton } from '@/components/copy-code-button'
import { useSyncedTab } from '@/lib/use-synced-tab'

interface ITabGroup {
  label: string
  code: string
  html: string
}

export function FrameworkTabs({
  groups,
  groupId = 'framework',
}: {
  groups: ITabGroup[]
  groupId?: string
}) {
  const labels = groups.map((group) => group.label)
  const [active, pick] = useSyncedTab(groupId, labels)

  return (
    <div className="border-site-border bg-site-surface/30 my-5 overflow-hidden rounded-xl border">
      <div role="tablist" className="border-site-border/60 flex gap-1 border-b px-2 pt-2">
        {groups.map((group) => {
          const selected = group.label === active

          return (
            <button
              key={group.label}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => pick(group.label)}
              className={`rounded-t-md px-3 py-1.5 font-mono text-xs transition-colors ${
                selected
                  ? 'bg-site-background text-site-accent-bright'
                  : 'text-site-muted hover:text-site-text'
              }`}
            >
              {group.label}
            </button>
          )
        })}
      </div>
      {groups.map((group) => (
        <div key={group.label} role="tabpanel" hidden={group.label !== active} className="group relative">
          <div
            className="overflow-x-auto px-4 py-3 text-xs leading-relaxed [&_pre]:!m-0 [&_pre]:!border-0 [&_pre]:!bg-transparent [&_pre]:!p-0"
            dangerouslySetInnerHTML={{ __html: group.html }}
          />
          <CopyCodeButton code={group.code} />
        </div>
      ))}
    </div>
  )
}
