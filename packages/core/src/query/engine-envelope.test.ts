/// <reference types="bun" />
/**
 * Every failure envelope carries its catalog code, whichever bridge encoded it,
 * so the same store, query or config fault reaches an app as the same typed
 * error everywhere. These pin the mapping in both directions.
 */

import { describe, expect, test } from 'bun:test'
import { isJsonObject, parseCallEnvelope, parseEngineJson, parseFailureEnvelope, readEngineJson, toThrowable } from './engine-envelope'
import { EEngineErrorCode, TEngineError } from '../wire/types'

/** Text no bridge answers with: not JSON, JSON that is no envelope, and an envelope missing the field its `ok` promises. */
const MALFORMED: string[] = ['null', '{}', '{"ok":false}', 'not json']

/** The error `run` throws, or `null` when it returns. */
const thrownBy = (run: () => unknown): unknown => {
  try {
    run()
  } catch (error) {
    return error
  }
  return null
}

const expectJsonError = (error: unknown): void => {
  expect(error).toBeInstanceOf(TEngineError)
  expect((error as TEngineError).code).toBe(EEngineErrorCode.JSON)
}

describe('engine envelope internal kind', () => {
  test('a code-carrying internal failure rebuilds the typed engine error', () => {
    const failure = toThrowable({
      kind: 'internal',
      code: EEngineErrorCode.LOCAL_UNSUPPORTED,
      message: 'query: unsupported filter',
    })

    expect(failure).toBeInstanceOf(TEngineError)
    expect((failure as TEngineError).code).toBe(EEngineErrorCode.LOCAL_UNSUPPORTED)
    expect(failure.message).toBe('query: unsupported filter')
  })

  test('a kind with no catalog code stays an untyped Error', () => {
    const failure = toThrowable({ kind: 'unknown_method', message: 'unknown engine method "nope"' })

    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(TEngineError)
  })

  test('a code outside the catalog stays an untyped Error', () => {
    const failure = toThrowable({ kind: 'internal', code: 'ENGINE', message: 'no such code' })

    expect(failure).not.toBeInstanceOf(TEngineError)
  })

  test('an internal envelope crossing a worker boundary keeps its code', () => {
    const raw = JSON.stringify({
      ok: false,
      error: { kind: 'internal', code: EEngineErrorCode.STORE, message: 'store: disk is full' },
    })
    const failure = parseFailureEnvelope(raw)

    expect(failure).toBeInstanceOf(TEngineError)
    expect(failure?.code).toBe(EEngineErrorCode.STORE)
  })

  test('parseCallEnvelope throws the typed error for an internal failure', () => {
    const raw = JSON.stringify({
      ok: false,
      error: { kind: 'internal', code: EEngineErrorCode.TRANSFER, message: 'transfer: gone' },
    })

    expect(() => parseCallEnvelope(raw)).toThrow(TEngineError)
  })
})

describe('the guarded envelope parse', () => {
  test.each(MALFORMED)('parseFailureEnvelope answers null for %p', (raw) => {
    expect(parseFailureEnvelope(raw)).toBeNull()
  })

  test.each(MALFORMED)('parseCallEnvelope throws the JSON engine error for %p', (raw) => {
    expectJsonError(thrownBy(() => parseCallEnvelope(raw)))
  })

  test('parseCallEnvelope answers the value of a success envelope, null included', () => {
    expect(parseCallEnvelope('{"ok":true,"value":{"cursor":"7"}}')).toEqual({ cursor: '7' })
    expect(parseCallEnvelope('{"ok":true,"value":null}')).toBeNull()
  })

  test('parseCallEnvelope throws the typed error a failure envelope carries', () => {
    const raw = '{"ok":false,"error":{"kind":"store_busy","code":"STORE_BUSY","message":"held","retryable":true}}'
    const error = thrownBy(() => parseCallEnvelope(raw))

    expect(error).toBeInstanceOf(TEngineError)
    expect((error as TEngineError).code).toBe(EEngineErrorCode.STORE_BUSY)
  })

  test('parseFailureEnvelope answers null for a success envelope and the typed error for a failure one', () => {
    expect(parseFailureEnvelope('{"ok":true,"value":1}')).toBeNull()
    expect(parseFailureEnvelope('{"ok":false,"error":{"kind":"bucket_unset","message":"unset"}}')?.code).toBe(EEngineErrorCode.BUCKET_UNSET)
  })

  test.each([
    '{"ok":true}',
    '{"ok":"false","error":{"kind":"remote","message":"m"}}',
    '{"ok":false,"error":null}',
    '{"ok":false,"error":{"kind":"remote"}}',
    '{"ok":false,"error":{"kind":"remote","message":"m","retryable":"no"}}',
    '{"ok":false,"error":{"kind":"remote","message":"m","code":7}}',
    '{"ok":false,"error":{"kind":"unknown_table","message":"m","table":["todos"]}}',
  ])('an envelope missing or mistyping a field the parser reads is malformed: %p', (raw) => {
    expectJsonError(thrownBy(() => parseCallEnvelope(raw)))
    expect(parseFailureEnvelope(raw)).toBeNull()
  })
})

describe('the guarded engine JSON parse', () => {
  test('parseEngineJson answers any JSON value and refuses text that is not JSON', () => {
    expect(parseEngineJson('null')).toBeNull()
    expect(parseEngineJson('{}')).toEqual({})
    expect(parseEngineJson('{"ok":false}')).toEqual({ ok: false })
    expect(parseEngineJson('[1,"a"]')).toEqual([1, 'a'])
    expectJsonError(thrownBy(() => parseEngineJson('not json')))
  })

  test('readEngineJson answers a value its guard accepts and refuses every other one', () => {
    expect(readEngineJson('{}', isJsonObject)).toEqual({})
    expect(readEngineJson('{"ok":false}', isJsonObject)).toEqual({ ok: false })

    for (const raw of ['null', '[]', '"text"', '7', 'not json']) {
      expectJsonError(thrownBy(() => readEngineJson(raw, isJsonObject)))
    }
  })
})
