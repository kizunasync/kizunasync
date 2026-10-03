'use client'

import { useState, type FormEvent } from 'react'
import type { TFeedbackReason } from '@/lib/clickup'

export type TFeedbackPhase = 'idle' | 'sending' | 'sent' | 'error' | 'unconfigured'

export interface IUseFeedbackFormResult {
  phase: TFeedbackPhase
  busy: boolean
  reason: TFeedbackReason
  setReason: (reason: TFeedbackReason) => void
  name: string
  setName: (name: string) => void
  email: string
  setEmail: (email: string) => void
  area: string
  setArea: (area: string) => void
  version: string
  setVersion: (version: string) => void
  message: string
  setMessage: (message: string) => void
  token: string | null
  setToken: (token: string | null) => void
  resetSignal: number
  submit: (event: FormEvent) => void
}

/** Owns every feedback-form field, the submit phase machine, and the POST to /api/feedback. */
export function useFeedbackForm(): IUseFeedbackFormResult {
  const [phase, setPhase] = useState<TFeedbackPhase>('idle')
  const [reason, setReason] = useState<TFeedbackReason>('feedback')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [area, setArea] = useState('')
  const [version, setVersion] = useState('')
  const [message, setMessage] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [resetSignal, setResetSignal] = useState(0)

  async function submitAsync(event: FormEvent): Promise<void> {
    event.preventDefault()
    setPhase('sending')

    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reason,
          email,
          name: name.trim() === '' ? undefined : name.trim(),
          area: area.trim() === '' ? undefined : area.trim(),
          version: version.trim() === '' ? undefined : version.trim(),
          message,
          turnstileToken: token ?? undefined,
        }),
      })

      if (response.status === 503) {
        setPhase('unconfigured')

        return
      }
      if (!response.ok) {
        setPhase('error')
        setResetSignal((n) => n + 1)

        return
      }
      setPhase('sent')
    } catch {
      setPhase('error')
      setResetSignal((n) => n + 1)
    }
  }

  return {
    phase,
    busy: phase === 'sending',
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
    submit: (event: FormEvent) => void submitAsync(event),
  }
}
