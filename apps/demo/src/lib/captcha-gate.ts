// MARK: - The captcha gate: one pending challenge shared by the widget and sign-in

/**
 * `signInPane` calls `request()` only when a brand-new anonymous identity must
 * be minted; the widget renders while the gate is pending and reports the
 * outcome through `resolve`. An error or expiry resolves with null, which is a
 * no-op: the gate stays pending on the same promise so the widget can be
 * retried without a second sign-in call. A token clears the pending state and
 * settles the promise sign-in is awaiting.
 */
export interface ICaptchaGate {
  request(): Promise<string>
  resolve(token: string | null): void
  isPending(): boolean
  subscribe(listener: () => void): () => void
}

export const createCaptchaGate = (): ICaptchaGate => {
  let pending: { promise: Promise<string>; resolve: (token: string) => void } | null = null
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const listener of listeners) {
      listener()
    }
  }

  return {
    request: () => {
      if (pending !== null) {
        return pending.promise
      }
      let resolveToken: (token: string) => void = () => {}
      const promise = new Promise<string>((resolve) => {
        resolveToken = resolve
      })

      pending = { promise, resolve: resolveToken }
      notify()

      return promise
    },
    resolve: (token) => {
      if (pending === null || token === null) {
        return
      }
      pending.resolve(token)
      pending = null
      notify()
    },
    isPending: () => pending !== null,
    subscribe: (listener) => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
  }
}
