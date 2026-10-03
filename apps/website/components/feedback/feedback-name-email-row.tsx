import { FIELD_CLASS } from '@/components/feedback/feedback-form.data'

export function FeedbackNameEmailRow({
  name,
  onNameChange,
  email,
  onEmailChange,
  busy,
}: {
  name: string
  onNameChange: (value: string) => void
  email: string
  onEmailChange: (value: string) => void
  busy: boolean
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1.5">
        <span className="text-site-muted text-xs">Name</span>
        <input
          type="text"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="Optional"
          disabled={busy}
          className={`${FIELD_CLASS} min-h-12`}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-site-muted text-xs">Email</span>
        <input
          type="email"
          required
          value={email}
          onChange={(event) => onEmailChange(event.target.value)}
          placeholder="you@example.com"
          disabled={busy}
          className={`${FIELD_CLASS} min-h-12`}
        />
      </label>
    </div>
  )
}
