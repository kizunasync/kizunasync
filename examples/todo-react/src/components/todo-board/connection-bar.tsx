import { Button } from '@heroui/react'
import type { ISyncHealth } from 'kizunasync'
import { formatClockTime } from '@kizunasync/utilities'
import { t } from '../../i18n'
import { ACCOUNTS, type TAccountKey } from '../../lib/account'

// MARK: - Connection bar

/** The Users account-switch row and the Connection sync bar. */
export function ConnectionBar({
  account,
  isOnline,
  requestSwitch,
  offline,
  setOffline,
  pendingWrites,
  health,
  note,
  isSyncing,
  syncNow,
}: {
  account: TAccountKey
  isOnline: boolean
  requestSwitch: (key: TAccountKey) => void
  offline: boolean
  setOffline: (value: boolean) => void
  pendingWrites: number
  health: ISyncHealth
  note: string | null
  isSyncing: boolean
  syncNow: () => Promise<void>
}) {
  return (
    <div className="actions">
      <p className="actions-title">Users</p>
      <div className="account-row" role="group" aria-label={t('account.switch')}>
        {ACCOUNTS.map((candidate) => {
          const active = account === candidate.key
          const disabled = !isOnline && !active

          return (
            <Button
              key={candidate.key}
              variant={active ? 'primary' : 'outline'}
              aria-pressed={active}
              isDisabled={disabled}
              onPress={() => requestSwitch(candidate.key)}
            >
              {candidate.label}
            </Button>
          )
        })}
      </div>

      <p className="share-note">{t('share.note')}</p>

      <p className="actions-title">Connection</p>
      <div className="sync-bar">
        <button
          type="button"
          className="sync-toggle"
          aria-pressed={!offline}
          aria-label={offline ? 'Go online' : 'Go offline'}
          onClick={() => setOffline(!offline)}
        >
          <span className={isOnline ? 'dot is-online' : 'dot is-offline'} aria-hidden="true" />
          <span className="sync-text" role="status">
            {isOnline ? t('sync.online') : t('sync.offline')} ·{' '}
            {t('sync.outbox', { count: pendingWrites })} ·{' '}
            {health.lastSuccessAt === null
              ? 'Not synced yet'
              : `Last sync ${formatClockTime(health.lastSuccessAt)}`}
            {note !== null ? ` · ${note}` : ''}
          </span>
          <span className={offline ? 'sync-switch' : 'sync-switch is-on'} aria-hidden="true">
            <span className="sync-switch-knob" />
          </span>
        </button>
        <Button variant="outline" size="sm" isDisabled={isSyncing} onPress={() => void syncNow()}>
          {isSyncing ? t('sync.syncing') : t('sync.now')}
        </Button>
      </div>
    </div>
  )
}
