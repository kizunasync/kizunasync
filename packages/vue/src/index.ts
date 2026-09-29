/**
 * Vue 3 bindings over @kizunasync/core, the TanStack-Query hybrid: a provide/inject
 * Provider for ergonomics PLUS an explicit { client } override on every
 * composable. Reactivity rides kizunasync.on; local reads are async (the driver may
 * run off the main thread) and resolve into refs.
 */
// MARK: - @kizunasync/vue public surface

export { createKizunaSyncPlugin, kizunasyncInjectionKey, provideKizunaSync, useKizunaSync, type IUseKizunaSyncOptions } from './provide'
export { useQuery, type IUseQueryOptions, type IUseQueryResult } from './use-query'
export { useMutation, type IUseMutationResult } from './use-mutation'
export { useSyncStatus, type IUseSyncStatusOptions, type IUseSyncStatusResult } from './use-sync-status'
export { useAttachment, type IUseAttachmentResult } from './use-attachment'
export { useRejections, type IUseRejectionsOptions, type IUseRejectionsResult } from './use-rejections'
export { useOverwrites, type IUseOverwritesOptions, type IUseOverwritesResult } from './use-overwrites'
