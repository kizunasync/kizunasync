'use client'

import { ICONS } from '@kizunasync/ui'
import { HERO_CLI_ARGS, PACKAGE_MANAGER_TABS, kizunasyncCommand, type TPackageManager } from '@/lib/site'
import { useCopyToClipboard } from '@/lib/use-copy-to-clipboard'
import { useSyncedTab } from '@/lib/use-synced-tab'

// MARK: - Hero command pill

/**
 * Copies the product CLI invocation for the selected package manager. The tab
 * choice shares persistence with docs `:::tabs{group=pm}` blocks.
 */
export function HeroCommand() {
  const { copied, copy } = useCopyToClipboard()
  const [active, pick] = useSyncedTab('pm', PACKAGE_MANAGER_TABS)
  const command = kizunasyncCommand(active as TPackageManager, HERO_CLI_ARGS)

  return (
    <div className="relative flex flex-col items-center gap-2">
      <div role="tablist" className="flex gap-1">
        {PACKAGE_MANAGER_TABS.map((label) => {
          const selected = label === active

          return (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => pick(label)}
              className={`rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors ${
                selected ? 'bg-site-surface text-site-accent-bright' : 'text-site-muted hover:text-site-text'
              }`}
            >
              {label}
            </button>
          )
        })}
      </div>
      <div className="border-site-border bg-site-surface/70 hover:border-site-accent-dim flex min-w-[22rem] items-center gap-2 rounded-lg border px-4 py-2 font-mono text-sm transition-colors">
        <span className="text-site-accent select-none">$</span>
        <button
          type="button"
          onClick={() => void copy(command)}
 aria-label={`${command}, copy to clipboard`}
          className="group flex min-w-0 flex-1 cursor-pointer items-center gap-2"
        >
          <span className="text-site-text text-left">{command}</span>
          <span className={copied ? 'text-site-accent' : 'text-site-faint group-hover:text-site-text'}>
            {copied ? '✓' : '⧉'}
          </span>
        </button>
        <span className="text-site-muted inline-flex shrink-0 items-center gap-1 text-[10px] leading-none font-semibold tracking-wide uppercase">
          <span className="inline-flex size-[1em] items-center justify-center" aria-hidden="true">
            <span className="nf leading-none">{ICONS.terminal}</span>
          </span>
          kizunasync
        </span>
      </div>
    </div>
  )
}
