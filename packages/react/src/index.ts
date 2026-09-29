/**
 * React bindings over the @kizunasync/core local-first client. Hybrid pattern: a
 * context Provider (KizunaSyncProvider/useKizunaSync) for ergonomics PLUS an explicit
 * { client } override on every hook: the override wins, the context is the
 * default. Drivers and the engine live in @kizunasync/core; this package depends
 * only on it plus React (peer).
 */
// MARK: - @kizunasync/react public surface

export { KizunaSyncProvider, useKizunaSync, type IClientOption, type IKizunaSyncProviderProps } from './provider'
export { useQuery, type IQueryOption, type IQueryResult } from './use-query'
export { useMutation, type IMutationResult } from './use-mutation'
export { useSyncStatus, type ISyncStatusOption, type ISyncStatusResult } from './use-sync-status'
export { useAttachment, type IUseAttachmentResult } from './use-attachment'
export { useRejections, type IRejectionsOption, type IRejectionsResult } from './use-rejections'
export { useOverwrites, type IOverwritesOption, type IOverwritesResult } from './use-overwrites'
