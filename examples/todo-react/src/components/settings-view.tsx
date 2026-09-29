import { useState } from 'react'
import { Button, Switch } from '@heroui/react'
import { messageOf } from '@kizunasync/utilities'
import type { IKizunaSyncShim } from '../kizunasync'
import { t } from '../i18n'
import { Brand } from './brand-header'
import { useSettings } from './settings-context'

// MARK: - Settings view

/**
 * `editAnyone` ("Test non-owner edit") lifts the client-side guard on the
 * registered users' todos only, so a non-owner write reaches the server. The
 * server returns RLS_DENIED and the engine reverts. Every other row on the
 * shared board is already writable. "Live sync" (default on) is the
 * realtime switch: off ⇒ the client only syncs when you tap "sync now". The
 * Network "Offline (simulated)" toggle force-suspends live sync regardless,
 * queues mutations locally, and flushes on flip-back (the SyncBar dot reads
 * the same flag). Force conflict, expire checkpoint, and reset local stay as
 * on-demand buttons.
 */
export function SettingsView({ client }: { client: IKizunaSyncShim }) {
  // MARK: - Variables
  const { editAnyone, setEditAnyone, live, setLive, offline, setOffline } = useSettings()
  const [message, setMessage] = useState<string | null>(null)

  // MARK: - render
  return (
    <div className="column">
      <Brand sub={t('settings.title')} />

      <p className="section-title">live sync</p>
      <ToggleRow
        label={t('settings.liveSync')}
        hint={t('settings.liveSync.hint')}
        value={live}
        onToggle={() => setLive(!live)}
      />

      <p className="section-title">network</p>
      <ToggleRow
        label="Offline (simulated)"
        hint="Queues mutations locally with no network. Live sync is suspended; flip back online to flush the outbox and resume."
        value={offline}
        onToggle={() => setOffline(!offline)}
      />

      <p className="section-title">reconciliation</p>
      <ToggleRow
        label={t('settings.editAnyone')}
        hint={t('settings.editAnyone.hint')}
        value={editAnyone}
        onToggle={() => setEditAnyone(!editAnyone)}
      />

      <p className="section-title">edge-case lab</p>
      <div className="lab-panel">
        <div className="lab-row">
          <LabButton
            label="force conflict"
            onPress={() => {
              void client.forceServerConflict().then(setMessage).catch((cause: unknown) => setMessage(messageOf(cause)))
            }}
          />
          <LabButton
            label="expire checkpoint"
            onPress={() => {
              void client.expireCheckpoint().then(() =>
                setMessage('cursor rewound: next sync re-walks history'),
              ).catch((cause: unknown) => setMessage(messageOf(cause)))
            }}
          />
          <LabButton
            label="reset local"
            onPress={() => {
              // Atomic wipe: store + outbox + attachment sandbox + the Debug rings. The wipe leaves nothing queued, so nothing wakes the engine and the Debug tab stays empty until the next sync.
              void client.resetLocal().then(() => {
                setMessage('local wiped: sync to re-hydrate the RLS-visible rows')
              }).catch((cause: unknown) => setMessage(messageOf(cause)))
            }}
          />
        </div>
        <p className="lab-hint">
          also try: airplane mode, kill the tab mid-outbox, two tabs on one account
        </p>
        {message !== null ? <p className="lab-message">{message}</p> : null}
      </div>
    </div>
  )
}

// MARK: - Pieces

function ToggleRow({
  label,
  hint,
  value,
  onToggle,
}: {
  label: string
  hint: string
  value: boolean
  onToggle: () => void
}) {
  return (
    <Switch.Root className="w-full" isSelected={value} onChange={onToggle} aria-label={label}>
      <Switch.Content className="toggle-card">
        <span className="toggle-card-text">
          <span className="toggle-card-label">{label}</span>
          <span className="toggle-card-hint">{hint}</span>
        </span>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
      </Switch.Content>
    </Switch.Root>
  )
}

function LabButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Button variant="outline" size="sm" onPress={onPress}>
      {label}
    </Button>
  )
}
