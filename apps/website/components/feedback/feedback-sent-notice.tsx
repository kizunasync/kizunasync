/** Confirmation shown once the feedback POST resolves 2xx. */
export function FeedbackSentNotice() {
  return (
    <output className="border-site-border bg-site-surface/50 mt-8 block rounded-2xl border p-6 text-center">
      <p className="text-site-ok text-sm font-medium">
 <span aria-hidden="true">✓ </span>Thanks. That&apos;s in the queue.
      </p>
      <p className="text-site-muted mt-1 text-sm">
        We read every submission; if you left an email we may follow up.
      </p>
    </output>
  )
}
