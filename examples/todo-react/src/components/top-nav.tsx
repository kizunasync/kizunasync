/**
 * Three tabs (TODO / Cache / Settings) as a segmented control. On wide
 * screens it rides a centered top bar with the 絆 Kizuna Sync brand; on narrow ones a
 * compact full-width segment bar pins to the bottom (CSS media query toggles
 * which bar shows). No router: the active tab is in-component state lifted to
 * App, matching expo-router's router.replace tab semantics (no history growth).
 * Two badges live here (top bar only), one per durable journal: useRejections
 * counts the writes the server refused, useOverwrites the columns another
 * device won. Each chip is hidden at 0 and opens its own journal on click.
 */

import { useState } from 'react'
import { Chip } from '@heroui/react'
import { useOverwrites, useRejections } from 'kizunasync/react'
import { OverwritesModal } from './overwrites-modal'
import { RejectionsModal } from './rejections-modal'
import { TopNavBrand } from './brand-header'
import { SegmentPill, SegmentPillGroup } from './segment-pill-group'

// MARK: - Segmented nav

export type TTab = 'todo' | 'cache' | 'settings'

interface ITabDef {
  key: TTab
  label: string
  glyph: string
}

const TABS: ITabDef[] = [
  { key: 'todo', label: 'TODO', glyph: '✓' },
  { key: 'cache', label: 'Debug', glyph: '◉' },
  { key: 'settings', label: 'Settings', glyph: '⚙' },
]

export function TopNav({ active, onSelect }: { active: TTab; onSelect: (tab: TTab) => void }) {
  const { rejections, dismiss } = useRejections()
  const { overwrites, dismiss: dismissOverwrite } = useOverwrites()
  const [rejectionsOpen, setRejectionsOpen] = useState(false)
  const [overwritesOpen, setOverwritesOpen] = useState(false)

  return (
    <nav className="topnav" aria-label="Sections">
      <div className="topnav-inner">
        <TopNavBrand />
        <div className="topnav-segment">
          <Segment active={active} onSelect={onSelect} />
        </div>
        {rejections.length > 0 ? (
          <Chip
            color="accent"
            variant="primary"
            role="button"
            tabIndex={0}
            aria-label="Rejections"
            onClick={() => setRejectionsOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setRejectionsOpen(true)
              }
            }}
          >
            {rejections.length}
          </Chip>
        ) : null}
        {overwrites.length > 0 ? (
          <Chip
            color="default"
            variant="secondary"
            role="button"
            tabIndex={0}
            aria-label="Overwrites"
            onClick={() => setOverwritesOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setOverwritesOpen(true)
              }
            }}
          >
            {overwrites.length}
          </Chip>
        ) : null}
      </div>
      {rejectionsOpen ? (
        <RejectionsModal
          rejections={rejections}
          onDismiss={(mutationId) => void dismiss(mutationId)}
          onClose={() => setRejectionsOpen(false)}
        />
      ) : null}
      {overwritesOpen ? (
        <OverwritesModal
          overwrites={overwrites}
          onDismiss={(id) => void dismissOverwrite(id)}
          onClose={() => setOverwritesOpen(false)}
        />
      ) : null}
    </nav>
  )
}

export function BottomNav({ active, onSelect }: { active: TTab; onSelect: (tab: TTab) => void }) {
  return (
    <nav className="bottomnav" aria-label="Sections">
      <Segment active={active} onSelect={onSelect} grow />
    </nav>
  )
}

// MARK: - Pieces

function Segment({
  active,
  onSelect,
  grow,
}: {
  active: TTab
  onSelect: (tab: TTab) => void
  grow?: boolean
}) {
  return (
    <SegmentPillGroup ariaLabel="Sections" grow={grow}>
      {TABS.map((tab) => {
        const isActive = tab.key === active

        return (
          <SegmentPill
            key={tab.key}
            isActive={isActive}
            onPress={() => {
              if (!isActive) {
                onSelect(tab.key)
              }
            }}
          >
            <span aria-hidden="true">{tab.glyph}</span>
            {tab.label}
          </SegmentPill>
        )
      })}
    </SegmentPillGroup>
  )
}
