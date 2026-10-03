/**
 * The Provider exists for ergonomics: one IKizunaSync instance, idiomatic React, no
 * per-hook plumbing. Every hook ALSO takes an explicit { client } override (the
 * TanStack Query pattern): the override wins when passed, the context is the
 * default. supabase-js uses a browser singleton for SSR reasons that do NOT apply
 * to a client-side local store, so this package keeps the provider and leans on
 * the override for the context-identity edge (SSR / microfrontends / gradual
 * adoption). See README.md for the full rationale.
 */
// MARK: - KizunaSyncProvider + useKizunaSync

import { createContext, createElement, useContext, type ReactNode } from 'react'
import { MISSING_CLIENT_MESSAGE, type IKizunaSync } from '@kizunasync/core'

// MARK: - Context

const KizunaSyncContext = createContext<IKizunaSync | null>(null)

export interface IKizunaSyncProviderProps {
  client: IKizunaSync
  children: ReactNode
}

export const KizunaSyncProvider = ({ client, children }: IKizunaSyncProviderProps): ReactNode =>
  createElement(KizunaSyncContext.Provider, { value: client }, children)

// MARK: - Resolution

export interface IClientOption {
  client?: IKizunaSync
}

export const useKizunaSync = (opts?: IClientOption): IKizunaSync => {
  const fromContext = useContext(KizunaSyncContext)
  const resolved = opts?.client ?? fromContext

  if (resolved === null || resolved === undefined) {
    throw new Error(MISSING_CLIENT_MESSAGE)
  }
  return resolved
}
