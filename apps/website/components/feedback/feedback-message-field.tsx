import { FIELD_CLASS } from '@/components/feedback/feedback-form.data'

export function FeedbackMessageField({
  message,
  onMessageChange,
  busy,
}: {
  message: string
  onMessageChange: (value: string) => void
  busy: boolean
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-site-muted text-xs">Message</span>
      <textarea
        required
        minLength={10}
        maxLength={5000}
        rows={6}
        value={message}
        onChange={(event) => onMessageChange(event.target.value)}
        placeholder="What happened, what you expected, and how to reproduce it if it's a bug."
        disabled={busy}
        className={`${FIELD_CLASS} min-h-32 resize-y py-3 leading-relaxed`}
      />
    </label>
  )
}
