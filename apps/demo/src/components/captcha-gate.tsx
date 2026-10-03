'use client'

import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { TurnstileWidget } from '@kizunasync/ui'
import type { ICaptchaGate } from '@kizunasync/utilities'
import { TURNSTILE_ACTION } from '@/runtime/demo-config'

// MARK: - Captcha gate

/**
 * Wraps the demo root. While the gate is pending the demo keeps rendering
 * behind a modal Turnstile check, and the root is inert so the check is the
 * only thing a visitor can reach. The dialog is a sibling of that root, outside
 * the inert subtree.
 */
export function CaptchaGate({ gate, siteKey, children }: { gate: ICaptchaGate; siteKey: string; children: ReactNode }) {
  // MARK: - Variables
  const isPending = useSyncExternalStore(gate.subscribe, gate.isPending, gate.isPending)

  // MARK: - render

  return (
    <>
      <div inert={isPending}>{children}</div>
      {isPending ? <CaptchaDialog siteKey={siteKey} onToken={(token) => gate.resolve(token)} /> : null}
    </>
  )
}

// MARK: - Pieces

/**
 * The panel receives focus only from script (`tabIndex={-1}`), never from Tab,
 * so it drops the global focus-visible outline that would otherwise ring the
 * whole dialog on open.
 */
function CaptchaDialog({ siteKey, onToken }: { siteKey: string; onToken: (token: string | null) => void }) {
  const titleId = useId()
  const textId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)

  // The Turnstile iframe loads later, so the dialog itself takes focus and a screen reader announces its title and text.
  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-site-scrim p-4 backdrop-blur-md animate-[site-fade-in_150ms_ease-out] motion-reduce:animate-none">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        tabIndex={-1}
        className="flex w-full max-w-sm flex-col gap-3 rounded-xl border border-site-border bg-site-surface p-5 shadow-site-elevated outline-none! animate-[site-dialog-in_200ms_ease-out] motion-reduce:animate-none"
      >
        <h2 id={titleId} className="m-0 text-base font-bold text-site-text">
          Start the demo
        </h2>
        <p id={textId} className="m-0 text-sm leading-relaxed text-site-muted">
          Cloudflare Turnstile checks once per visitor that you are human.
        </p>
        <TurnstileWidget siteKey={siteKey} action={TURNSTILE_ACTION} theme="dark" onToken={onToken} />
      </div>
    </div>
  )
}
