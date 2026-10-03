import { FIELD_CLASS } from '@/components/feedback/feedback-form.data'

export function FeedbackAreaVersionRow({
  area,
  onAreaChange,
  version,
  onVersionChange,
  busy,
}: {
  area: string
  onAreaChange: (value: string) => void
  version: string
  onVersionChange: (value: string) => void
  busy: boolean
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1.5">
        <span className="text-site-muted text-xs">Area</span>
        <input
          type="text"
          maxLength={120}
          value={area}
          onChange={(event) => onAreaChange(event.target.value)}
          placeholder="e.g. CLI, docs, expo driver"
          disabled={busy}
          className={`${FIELD_CLASS} min-h-12`}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-site-muted text-xs">Version</span>
        <input
          type="text"
          maxLength={40}
          value={version}
          onChange={(event) => onVersionChange(event.target.value)}
          placeholder="e.g. 0.3.1"
          disabled={busy}
          className={`${FIELD_CLASS} min-h-12`}
        />
      </label>
    </div>
  )
}
