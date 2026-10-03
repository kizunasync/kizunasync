/**
 * Engine events, kizunasync.pull/push round trips with their real byte sizes,
 * and per-mutation server verdicts, interleaved and tagged with the pane that
 * produced them. Order in the list is the order the server saw them, and that
 * order decides a contested column.
 *
 * Auto-scroll pauses while the pointer is over the list, so a reader can inspect
 * an entry without the feed yanking it away.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/button'
import { PaneTag } from '@/components/pane-tag'
import { Tip } from '@/components/tip'
import { EWireEntryKind, type TWireEntryKind } from 'kizunasync'
import { formatBytes, isRejection, labelEntry, WIRE_RING_CAP, type IWireLog, type TWireEntry } from '@/runtime/wire-log'
import { describeEntry } from '@/lib/describe-entry'
import { formatClockTime } from '@kizunasync/utilities'

// MARK: - Wire viewer

const BADGE_CLASS =
  'shrink-0 rounded-sm px-1.5 py-px text-xs font-bold tracking-wide text-site-background'

const KIND_TONE_CLASS: Record<TWireEntryKind, string> = {
  [EWireEntryKind.engine]: 'bg-site-faint',
  [EWireEntryKind.rpc]: 'bg-site-muted',
  [EWireEntryKind.verdict]: 'bg-site-ok',
  [EWireEntryKind.note]: 'bg-site-gold',
}

export function WireViewer({ wireLog }: { wireLog: IWireLog }) {
  // MARK: - Variables
  const entries = useSyncExternalStore(wireLog.subscribe, wireLog.entries)
  const [isPaused, setIsPaused] = useState(false)
  const listRef = useRef<HTMLOListElement>(null)

  // MARK: - Lifecycle

  // Scroll position of a DOM node is external-system synchronization, so it lives in an effect, not in render.
  useEffect(() => {
    const list = listRef.current

    if (list === null || isPaused) {
      return
    }
    list.scrollTop = list.scrollHeight
  }, [entries, isPaused])

  // MARK: - render

  return (
    <section
      className="relative flex flex-col gap-3 rounded-2xl border border-site-border bg-site-surface p-4"
      aria-label="Wire viewer"
    >
      {isPaused ? (
        <p
          className="pointer-events-none absolute right-4 bottom-4 z-10 m-0 rounded-md border border-site-gold bg-site-background px-2 py-1 text-xs text-site-gold"
          role="status"
        >
          Auto-scroll paused while you read.
        </p>
      ) : null}

      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <h2 className="m-0 text-sm font-bold">The wire</h2>
        <p className="m-0 min-w-48 flex-1 text-xs text-site-muted">
          Every engine event, RPC round trip, and server verdict from both panes, newest last. Keeps the last{' '}
          {WIRE_RING_CAP} entries.
        </p>
        <Tip text="Clears this log only, the panes and their synced data are untouched">
          <Button type="button" onClick={wireLog.clear}>
            Clear
          </Button>
        </Tip>
      </header>

      {entries.length === 0 ? (
        <p className="m-0 py-4 text-center text-sm text-site-muted">
          Nothing on the wire yet. Add a todo, or sync a pane.
        </p>
      ) : (
        <ol
          className="m-0 grid max-h-96 list-none grid-cols-[max-content_max-content_max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 overflow-y-auto p-0 scroll-smooth motion-reduce:scroll-auto md:grid-cols-[max-content_max-content_max-content_max-content_max-content_max-content_minmax(0,1fr)]"
          ref={listRef}
          onMouseEnter={() => setIsPaused(true)}
          onMouseLeave={() => setIsPaused(false)}
        >
          {entries.map((entry) => (
            <WireRow key={entry.id} entry={entry} />
          ))}
        </ol>
      )}
    </section>
  )
}

// MARK: - Pieces

/**
 * `grid-cols-subgrid` + `col-span-full` makes this `<li>`'s own columns the same
 * tracks as the `<ol>`'s, so every row's cells line up. A per-row flex cannot.
 * Below md the entry takes two lines: sending the byte counts back to column 1
 * breaks the line after the identity cells, and a phone-width pane never pans
 * sideways. Row background/accent lives on the `<li>` itself (a real box,
 * unlike a `display:contents` row), so the rejected/verdict highlight wraps
 * whichever lines the entry occupies.
 */
function WireRow({ entry }: { entry: TWireEntry }) {
  const rejected = isRejection(entry)

  return (
    <li
      className={`grid grid-cols-subgrid col-span-full items-center gap-y-1 rounded-lg border px-2 py-1 ${
        rejected ? 'border-site-danger bg-site-danger/15' : 'border-transparent bg-site-background'
      }`}
    >
      <span className="font-mono text-xs text-site-muted">{formatClockTime(entry.at)}</span>
      <PaneTag pane={entry.pane} />
      <span className={`${BADGE_CLASS} ${rejected ? 'bg-site-danger' : KIND_TONE_CLASS[entry.kind]}`}>
        {labelEntry(entry)}
      </span>
      <span className="col-start-1 font-mono text-xs text-site-muted md:col-start-auto">{bytesOutOf(entry)}</span>
      <span className="font-mono text-xs text-site-muted">{bytesInOf(entry)}</span>
      <span className="font-mono text-xs text-site-muted">{durationOf(entry)}</span>
      <span className="min-w-0 truncate text-xs text-site-muted">{describeEntry(entry)}</span>
    </li>
  )
}

// MARK: - Column values

function bytesOutOf(entry: TWireEntry): string {
  return entry.kind === EWireEntryKind.rpc ? formatBytes(entry.call.bytesOut) : ''
}

function bytesInOf(entry: TWireEntry): string {
  return entry.kind === EWireEntryKind.rpc ? formatBytes(entry.call.bytesIn) : ''
}

function durationOf(entry: TWireEntry): string {
  return entry.kind === EWireEntryKind.rpc ? `${String(Math.round(entry.call.durationMs))}ms` : ''
}
