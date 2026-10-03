import type { TFeedbackReason } from '@/lib/clickup'
import { FIELD_CLASS, REASON_OPTIONS } from '@/components/feedback/feedback-form.data'

export function FeedbackReasonSelect({
  reason,
  onReasonChange,
  busy,
}: {
  reason: TFeedbackReason
  onReasonChange: (reason: TFeedbackReason) => void
  busy: boolean
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-site-muted text-xs">What is this about?</span>
      <select
        value={reason}
        onChange={(event) => onReasonChange(event.target.value as TFeedbackReason)}
        disabled={busy}
        className={`${FIELD_CLASS} min-h-12`}
      >
        {REASON_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}
