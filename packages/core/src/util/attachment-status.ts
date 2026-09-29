/**
 * `useAttachment`'s field-by-field defaulting of a `TAttachmentStatus | null`
 * into display state, owned once here so the React hook and the Vue composable
 * show the same defaults. It is split in two so each function stays under the
 * shape targets (@../../../../CONVENTIONS.md): the six `?.`/`??` fallbacks read
 * as one function's branches even though there is no real decision beyond "is
 * there a status yet".
 */
// MARK: - Attachment status fields

import type { TAttachmentStatus } from '../host/attachment-queue'
import type { TAttachmentState } from '../wire/types'

export interface IAttachmentDisplayFields {
  state: TAttachmentState | 'idle'
  progress: number
  localUri: string | null
}

export function toAttachmentDisplayFields(status: TAttachmentStatus | null): IAttachmentDisplayFields {
  return {
    state: status?.state ?? 'idle',
    progress: status?.progress ?? 0,
    localUri: status?.localUri ?? null,
  }
}

export interface IAttachmentBudgetFields {
  error: string | null
  permanent: boolean
  attempts: number
}

export function toAttachmentBudgetFields(status: TAttachmentStatus | null): IAttachmentBudgetFields {
  return {
    error: status?.error ?? null,
    permanent: status?.permanent ?? false,
    attempts: status?.attempts ?? 0,
  }
}
