import { GITHUB_URL } from '@/lib/site'
import { SUPPORT_EMAIL } from '@/components/feedback/feedback-form.data'

/** Shown when the API route reports itself unconfigured (503): points people at GitHub issues or email instead. */
export function FeedbackUnconfiguredNotice() {
  return (
    <div className="border-site-border bg-site-surface/50 mt-8 rounded-2xl border p-6 text-sm leading-relaxed">
      <p className="font-medium">This form isn&apos;t wired up on the current deploy.</p>
      <p className="text-site-muted mt-2">
        Open an issue on{' '}
        <a
          href={`${GITHUB_URL}/issues`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-site-accent hover:underline"
        >
          GitHub
        </a>{' '}
        or email{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="text-site-accent hover:underline">
          {SUPPORT_EMAIL}
        </a>{' '}
 instead; both reach the same place.
      </p>
    </div>
  )
}
