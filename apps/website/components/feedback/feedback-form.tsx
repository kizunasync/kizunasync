'use client'

import { TurnstileWidget } from '@kizunasync/ui'
import { FeedbackAreaVersionRow } from '@/components/feedback/feedback-area-version-row'
import { FeedbackMessageField } from '@/components/feedback/feedback-message-field'
import { FeedbackNameEmailRow } from '@/components/feedback/feedback-name-email-row'
import { FeedbackReasonSelect } from '@/components/feedback/feedback-reason-select'
import { FeedbackSentNotice } from '@/components/feedback/feedback-sent-notice'
import { FeedbackUnconfiguredNotice } from '@/components/feedback/feedback-unconfigured-notice'
import { TURNSTILE_SITE_KEY } from '@/lib/turnstile'
import { useFeedbackForm } from '@/lib/use-feedback-form'

// MARK: - Feedback form

export function FeedbackForm() {
  const {
    phase,
    busy,
    reason,
    setReason,
    name,
    setName,
    email,
    setEmail,
    area,
    setArea,
    version,
    setVersion,
    message,
    setMessage,
    token,
    setToken,
    resetSignal,
    submit,
  } = useFeedbackForm()

  const captchaOn = TURNSTILE_SITE_KEY !== ''

  if (phase === 'sent') {
    return <FeedbackSentNotice />
  }

  if (phase === 'unconfigured') {
    return <FeedbackUnconfiguredNotice />
  }

  return (
    <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
      <FeedbackNameEmailRow name={name} onNameChange={setName} email={email} onEmailChange={setEmail} busy={busy} />
      <FeedbackReasonSelect reason={reason} onReasonChange={setReason} busy={busy} />
      <FeedbackAreaVersionRow
        area={area}
        onAreaChange={setArea}
        version={version}
        onVersionChange={setVersion}
        busy={busy}
      />
      <FeedbackMessageField message={message} onMessageChange={setMessage} busy={busy} />

      {captchaOn ? (
        <TurnstileWidget
          siteKey={TURNSTILE_SITE_KEY}
          action="feedback-v1"
          onToken={setToken}
          resetSignal={resetSignal}
        />
      ) : null}

      {phase === 'error' ? (
        <p className="text-site-danger text-sm">
          Something went wrong sending that. Try again in a minute.
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy || (captchaOn && token === null)}
        className="bg-site-accent text-site-accent-foreground hover:bg-site-accent-bright cursor-pointer rounded-lg px-5 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 sm:self-start"
      >
        {busy ? 'Sending…' : 'Send feedback'}
      </button>
    </form>
  )
}
