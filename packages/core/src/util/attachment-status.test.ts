// MARK: - attachment-status fields

import { describe, expect, test } from 'bun:test'
import type { TAttachmentStatus } from '../host/attachment-queue'
import { EAttachmentState } from '../wire/types'
import { toAttachmentBudgetFields, toAttachmentDisplayFields } from './attachment-status'

const status = (overrides: Partial<TAttachmentStatus> = {}): TAttachmentStatus => ({
  state: EAttachmentState.downloading,
  progress: 42,
  localUri: 'uri-a',
  error: 'transient failure',
  permanent: true,
  attempts: 2,
  ...overrides,
})

describe('toAttachmentDisplayFields', () => {
  test('a null status defaults to idle', () => {
    expect(toAttachmentDisplayFields(null)).toEqual({ state: 'idle', progress: 0, localUri: null })
  })

  test('a present status passes its fields through unchanged', () => {
    expect(toAttachmentDisplayFields(status())).toEqual({
      state: EAttachmentState.downloading,
      progress: 42,
      localUri: 'uri-a',
    })
  })
})

describe('toAttachmentBudgetFields', () => {
  test('a null status defaults to no error, not permanent, zero attempts', () => {
    expect(toAttachmentBudgetFields(null)).toEqual({ error: null, permanent: false, attempts: 0 })
  })

  test('a present status passes its fields through unchanged', () => {
    expect(toAttachmentBudgetFields(status())).toEqual({
      error: 'transient failure',
      permanent: true,
      attempts: 2,
    })
  })
})
