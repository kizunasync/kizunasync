/**
 * Replays the `@kizunasync/protocol` golden corpus against the real engine: reads the
 * corpus in place (zero forked bytes; @../../../../CONVENTIONS.md), asserts the
 * engine's request bytes are canonical, replays the golden responses, and treats
 * every local/assert/fault step as a client-state obligation.
 */

// MARK: - @kizunasync/core/conformance

export { resolveCorpusRoot } from './corpus-path'
export { HarnessSequenceError, RequestDivergenceError, TranscriptRemote, TransportFaultError } from './transcript-remote'
export { configFromContext, runCorpusClient, runTranscriptClient, type TClientFailure, type TClientResult, type TStepOutcome } from './client-executor'
export { FIXED_NOW, makeTransportClient, type ITransportClientOptions } from './transport-client'
/**
 * The one envelope parser, re-exported for harnesses that drive a transport
 * directly (the browser lane's `ping` / `store_kind` / `query`): a second reader
 * would classify failures its own way.
 */
export { parseCallEnvelope } from '../query/engine-envelope'
export { type IProtocolClient, type TLocalMutationSpec, type TReadableRow, type TTranscriptStep } from './client-contract'
