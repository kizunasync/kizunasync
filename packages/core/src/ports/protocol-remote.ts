// MARK: - ProtocolRemote port

/**
 * The client-side twin of packages/protocol/executor/server-contract.ts
 * IProtocolServer.pull/push: the engine talks RPCs, not domain-coupled Supabase
 * query chains. `createRpcRemote` in @kizunasync/supabase satisfies this structurally
 * by calling supabase.rpc('kizunasync.pull' | 'kizunasync.push', body). The
 * conformance harness's TranscriptRemote implements it by replaying golden
 * response bytes.
 */

import type { TPullRequest, TPullResponse, TPushRequest, TPushResponse } from '../wire/types'

export interface IProtocolRemote {
  pull(request: TPullRequest): Promise<TPullResponse>
  push(request: TPushRequest): Promise<TPushResponse>
}
