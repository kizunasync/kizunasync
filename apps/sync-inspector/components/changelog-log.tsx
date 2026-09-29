import { StatusPill, type TPillTone } from '@/components/status-pill'
import { TimeCell } from '@/components/time-cell'
import { describeChange, ECHANGE_OP } from '@/lib/describe-change'
import { shortId } from '@/lib/formatters'
import type { IChangelogRow } from '@/lib/inspector-data'
import { useNow } from '@/lib/use-now'

// MARK: - Changelog log

/**
 * A pseudo-tabular log rather than a table: the aligned columns carry the raw
 * record (step, table, op, row, arrival) and the last column says in English
 * what the entry means for the fleet. Newest first: the order the panel's
 * query returns, which is the order a reader scans.
 */
const OP_TONE: Record<string, TPillTone> = {
  [ECHANGE_OP.UPSERT]: 'accent',
  [ECHANGE_OP.DELETE]: 'gold',
}

const COLUMN_LABELS = ['step', 'table', 'op', 'row', 'time', 'explanation'] as const

/**
 * Below md an entry takes two lines instead of one: the raw identity (step,
 * table, op) first, then the row id, its arrival and the explanation. Sending
 * the fourth cell back to column 1 is what breaks the line: in the header
 * labels and in every row alike, so the two stay aligned.
 */
const SECOND_LINE_INDEX = 3
const SECOND_LINE_CLASS = 'col-start-1 md:col-start-auto'

export function ChangelogLog({ rows }: { rows: IChangelogRow[] }) {
  const now = useNow()

  return (
    <ol className="m-0 grid max-h-[30vh] list-none grid-cols-[max-content_max-content_max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 overflow-y-auto p-1 md:grid-cols-[max-content_max-content_max-content_max-content_max-content_minmax(0,1fr)]">
      <HeaderRow />
      {rows.map((row) => (
        <ChangeRow key={`${row.table_name}-${row.pk}-${String(row.seq)}`} row={row} now={now} />
      ))}
    </ol>
  )
}

// MARK: - Pieces

/**
 * Column labels, hidden from assistive tech: they name tracks a sighted
 * reader scans, while every row already carries its meaning as prose in the
 * explanation cell. Scrolls with the log rather than sticking.
 */
function HeaderRow() {
  return (
    <li
      className="text-site-muted col-span-full grid grid-cols-subgrid px-2 pb-1 text-[0.62rem] font-medium tracking-wider uppercase"
      aria-hidden="true"
    >
      {COLUMN_LABELS.map((label, index) => (
        <span key={label} className={index === SECOND_LINE_INDEX ? SECOND_LINE_CLASS : undefined}>
          {label}
        </span>
      ))}
    </li>
  )
}

/**
 * `grid-cols-subgrid` + `col-span-full` makes this `<li>`'s columns the SAME
 * tracks as the `<ol>`'s: that is what lines every row's cells up, which a
 * per-row flex cannot do. The row box keeps wrapping whichever lines the entry
 * occupies, one at md and above, two below it.
 */
function ChangeRow({ row, now }: { row: IChangelogRow; now: number | null }) {
  return (
    <li className="border-site-border/30 hover:bg-site-raised/40 col-span-full grid grid-cols-subgrid items-center gap-y-1 rounded-lg border border-transparent px-2 py-1 transition-colors">
      <span className="text-site-muted font-mono text-xs tabular-nums">{row.seq}</span>
      <span className="font-mono text-xs">{row.table_name}</span>
      <StatusPill tone={OP_TONE[row.op] ?? 'muted'}>{row.op}</StatusPill>
      <span className={`text-site-muted font-mono text-xs ${SECOND_LINE_CLASS}`} title={row.pk}>
        {shortId(row.pk)}
      </span>
      <span className="text-site-muted font-mono text-xs tabular-nums">
        <TimeCell iso={row.arrived_at} now={now} />
      </span>
      <span className="text-site-muted col-span-2 min-w-0 truncate text-xs md:col-auto">
        {describeChange(row)}
      </span>
    </li>
  )
}
