/**
 * provideKizunaSync seeds a single IKizunaSync down the component tree via a module
 * InjectionKey; useKizunaSync resolves opts.client first (the explicit override that
 * always wins, like TanStack Query's `client` arg) and falls back to inject().
 * Neither present ⇒ fail loud, never a silent undefined client.
 */
// MARK: - Provider + resolver

import { type App, type InjectionKey, inject, provide } from 'vue'
import { MISSING_CLIENT_MESSAGE, type IKizunaSync } from '@kizunasync/core'

// MARK: - Injection key

export const kizunasyncInjectionKey: InjectionKey<IKizunaSync> = Symbol('kizunasync')

// MARK: - Provider

/**
 * Seed the IKizunaSync instance into the current component's provide scope. Call
 * inside setup() of an ancestor; descendants resolve it via useKizunaSync().
 */
export const provideKizunaSync = (client: IKizunaSync): void => {
  provide(kizunasyncInjectionKey, client)
}

/**
 * App-level plugin form: `app.use(createKizunaSyncPlugin(client))`. Mirrors the
 * provideKizunaSync ergonomics for apps that wire the client at bootstrap.
 */
export const createKizunaSyncPlugin = (client: IKizunaSync): { install: (app: App) => void } => ({
  install(app) {
    app.provide(kizunasyncInjectionKey, client)
  },
})

// MARK: - Resolver

export interface IUseKizunaSyncOptions {
  client?: IKizunaSync
}

/**
 * Resolve the active IKizunaSync: the explicit opts.client override wins; otherwise
 * the provided instance. Throws if neither is available (no silent fallback).
 */
export const useKizunaSync = (opts?: IUseKizunaSyncOptions): IKizunaSync => {
  const client = opts?.client ?? inject(kizunasyncInjectionKey, undefined)

  if (client === undefined) {
    throw new Error(MISSING_CLIENT_MESSAGE)
  }
  return client
}
