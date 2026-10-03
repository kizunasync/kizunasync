import type { IInspectorSnapshot } from 'kizunasync'
import { t } from '../../i18n'
import { onActivate } from './badges'
import type { TDialogContent } from './detail-modal'

// MARK: - Stats row

/** Outbox depth, cursor, and last mutation id: each opens its detail dialog on click. */
export function StatsRow({
  snapshot,
  onOpenDialog,
}: {
  snapshot: IInspectorSnapshot | null
  onOpenDialog: (content: TDialogContent) => void
}) {
  function openStat(title: string, body: string, value: string): void {
    onOpenDialog({ title, body, value })
  }

  return (
    <>
      <div className="stats-row">
        <Stat
          label="outbox depth"
          value={String(snapshot?.depth ?? 0)}
          onClick={() =>
            openStat(t('cache.outboxDepth.title'), t('cache.outboxDepth.body'), String(snapshot?.depth ?? 0))
          }
        />
        <Stat
          label="cursor"
          value={snapshot?.cursor ?? 'n/a'}
          onClick={() => openStat(t('cache.cursor.title'), t('cache.cursor.body'), snapshot?.cursor ?? 'n/a')}
        />
      </div>
      <Stat
        label="last mutation id"
        value={snapshot?.lastMutationId ?? 'n/a'}
        full
        onClick={() =>
          openStat(t('cache.lastMutationId.title'), t('cache.lastMutationId.body'), snapshot?.lastMutationId ?? 'n/a')
        }
      />
    </>
  )
}

// MARK: - internal

function Stat({
  label,
  value,
  full,
  onClick,
}: {
  label: string
  value: string
  full?: boolean
  onClick?: () => void
}) {
  const clickable = onClick !== undefined

  return (
    <div
      className={[full === true ? 'stat is-full' : 'stat', clickable ? 'cache-clickable' : ''].filter(Boolean).join(' ')}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick !== undefined ? onActivate(onClick) : undefined}
    >
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  )
}
