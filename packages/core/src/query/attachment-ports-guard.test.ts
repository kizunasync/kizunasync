/// <reference types="bun" />
/**
 * What `createKizunaSync` refuses before it looks for an engine at all. The
 * attachment-port guard is the only such refusal left: it fires on the config
 * alone, so a misconfigured client is rejected identically on a machine that
 * built an engine artifact and one that did not.
 *
 * Which engine backs a client that passes this guard is select-engine.test.ts's
 * subject, and that it is the Rust core is napi-engine.test.ts's.
 */

import { describe, expect, test } from 'bun:test'
import { attachment, defineConfig } from '../config/config'
import { createKizunaSync } from './kizunasync'
import { EEngineErrorCode, TEngineError } from '../wire/types'
import type { IStoreLocator } from '../ports/store-locator'
import type { IProtocolRemote } from '../ports/protocol-remote'

/**
 * The guard runs on the config before either is read, so neither needs to
 * reach a store or a server.
 */
const stubDb: IStoreLocator = { databasePath: null }
const stubRemote = {} as IProtocolRemote

const attachConfig = defineConfig({
  tables: {
    items: {
      sync: 'read-write',
      attachments: {
        image_path: attachment('items', { ownerColumn: 'id' }),
      },
    },
  },
})

describe('what createKizunaSync refuses before choosing an engine', () => {
  test('a config declaring attachment() without both byte ports is refused first', () => {
    try {
      createKizunaSync(stubDb, stubRemote, attachConfig)
      expect.unreachable('expected ATTACHMENT_PORTS_MISSING')
    } catch (error) {
      expect(error).toBeInstanceOf(TEngineError)
      expect((error as TEngineError).code).toBe(EEngineErrorCode.ATTACHMENT_PORTS_MISSING)
    }
  })
})
