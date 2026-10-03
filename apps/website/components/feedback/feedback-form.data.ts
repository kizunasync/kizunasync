import type { TFeedbackReason } from '@/lib/clickup'

export const REASON_OPTIONS: { value: TFeedbackReason; label: string }[] = [
  { value: 'feedback', label: 'General feedback' },
  { value: 'bug', label: 'Bug report' },
  { value: 'question', label: 'Question' },
]

export const SUPPORT_EMAIL = 'kizunasync@smartsquad.io'

export const FIELD_CLASS =
  'border-site-border bg-site-surface placeholder:text-site-faint w-full rounded-xl border px-4 text-sm outline-none'
