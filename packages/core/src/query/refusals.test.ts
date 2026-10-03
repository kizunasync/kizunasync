/// <reference types="bun" />
/**
 * A refused construct names the page that lists every postgrest-js method and
 * its status, so the reader lands on the whole answer rather than one method's
 * page.
 */

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { EEngineErrorCode } from '../wire/types'
import { unsupported } from './refusals'

const OPERATORS_PAGE = 'docs/reference/query-operators.md'

test('a refusal points at the supported query operators page', () => {
  const error = unsupported('rpc()')

  expect(error.code).toBe(EEngineErrorCode.LOCAL_UNSUPPORTED)
  expect(error.message).toBe(`"rpc()" is not supported by the local query API (no network fallback): see the supported query operators in ${OPERATORS_PAGE}`)
  expect(existsSync(resolve(import.meta.dir, '../../../..', OPERATORS_PAGE))).toBe(true)
})
