// MARK: - TranscriptRemote

/**
 * Client-harness remote. It does not compute responses: that is the
 * reference server's job (`packages/protocol/executor/reference.ts`). It
 * replays the golden `response` bytes of the transcript's current rpc/fault
 * step, and asserts the engine sent the byte-exact `request`: it
 * canonicalizes the engine's outgoing request through the protocol
 * canonicalizer and compares it to `canonicalize(step.request)` (`executor.ts`
 * proves server responses this way; this proves client requests). The
 * executor primes it step-by-step via `expect()` / `expectFault()` before
 * triggering the engine.
 *
 * The server suite proved responses against the golden bytes; this proves
 * the engine's requests and its state reactions against the same un-forked
 * corpus.
 */

import { canonicalize } from '@kizunasync/protocol/harness/canonical'
import type { IProtocolRemote } from '../ports/protocol-remote'
import type { TPullRequest, TPullResponse, TPushRequest, TPushResponse } from '../wire/types'
import type { TTranscriptStep } from './client-contract'

// MARK: - Errors

/**
 * A request-bytes divergence: the engine's wire output is not byte-equal to the
 * golden request. Carries both canonical serializations for the executor's
 * failure report (mirrors executor.ts TExecutionFailure).
 */
export class RequestDivergenceError extends Error {
  readonly rpc: 'pull' | 'push'
  readonly expected: string
  readonly actual: string
  constructor(rpc: 'pull' | 'push', expected: string, actual: string) {
    super(`${rpc} request diverged from the golden bytes (C-7)`)
    this.name = 'RequestDivergenceError'
    this.rpc = rpc
    this.expected = expected
    this.actual = actual
  }
}

/**
 * The transport-error fault: the request never reached the server (P:verdict-completeness-transforms-and-conflict-rejection). The
 * engine must treat it as a transient failure (nothing applied, work left
 * queued, cursor untouched), never as a verdict or signal.
 */
export class TransportFaultError extends Error {
  readonly rpc: 'pull' | 'push'
  constructor(rpc: 'pull' | 'push') {
    super(`${rpc}: transport-error (request never applied)`)
    this.name = 'TransportFaultError'
    this.rpc = rpc
  }
}

/**
 * A protocol violation in how the harness was driven (no active step, wrong rpc
 * kind, double invocation): a harness bug, surfaced loudly; it is not masked.
 */
export class HarnessSequenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HarnessSequenceError'
  }
}

// MARK: - Active expectation

type TFaultMode = 'none' | 'drop-ack' | 'transport-error'

type TExpectation = {
  rpc: 'pull' | 'push'
  request: unknown // golden request bytes (JSON value) to assert against
  response: unknown // golden response bytes (JSON value) to replay
  fault: TFaultMode
  consumed: boolean
}

// MARK: - TranscriptRemote

export class TranscriptRemote implements IProtocolRemote {
  private active: TExpectation | null = null

  /**
   * Prime the remote for an `rpc` step: the next pull()/push() the engine makes
   * must match step.rpc and step.request, and receives step.response.
   */
  expect(step: TTranscriptStep): void {
    const rpc = step.rpc === 'push' ? 'push' : 'pull'

    this.active = {
      rpc,
      request: step.request,
      response: step.response,
      fault: 'none',
      consumed: false,
    }
  }

  /**
   * Prime the remote for a `fault` step. drop-ack: the engine's call is applied
   * server-side but the response is lost, so we assert the request bytes and then
   * throw so the in-flight call rejects (the engine retries on the next rpc).
   * transport-error: the request never reached the server, so there is NO request
   * to assert (the fault step carries none for transport-error) and the call
   * rejects with a transport fault.
   */
  expectFault(step: TTranscriptStep): void {
    const rpc = step.target === 'push' ? 'push' : 'pull'
    const fault: TFaultMode = step.fault === 'drop-ack' ? 'drop-ack' : 'transport-error'

    this.active = {
      rpc,
      request: step.request,
      response: step.response,
      fault,
      consumed: false,
    }
  }

  // MARK: - IProtocolRemote

  pull(request: TPullRequest): Promise<TPullResponse> {
    return this.handle('pull', request) as Promise<TPullResponse>
  }

  push(request: TPushRequest): Promise<TPushResponse> {
    return this.handle('push', request) as Promise<TPushResponse>
  }

  // MARK: - Core replay + request assertion

  private handle(rpc: 'pull' | 'push', request: unknown): Promise<unknown> {
    const active = this.active

    if (active === null) {
      return Promise.reject(
        new HarnessSequenceError(`engine called ${rpc}() with no primed transcript step`)
      )
    }
    if (active.consumed) {
      return Promise.reject(
        new HarnessSequenceError(`engine called ${rpc}() twice for a single primed step`)
      )
    }
    if (active.rpc !== rpc) {
      return Promise.reject(
        new HarnessSequenceError(
          `engine called ${rpc}() but the primed step is a ${active.rpc} step`
        )
      )
    }
    active.consumed = true

    // transport-error never reaches the server: no request bytes are pinned, so there is nothing to assert, so reject before any apply (P:verdict-completeness-transforms-and-conflict-rejection).
    if (active.fault === 'transport-error') {
      return Promise.reject(new TransportFaultError(rpc))
    }

    // Byte-exact request conformance (the client-side mirror of executor.ts:165).
    const expected = canonicalize(active.request)
    const actual = canonicalize(request)

    if (actual !== expected) {
      return Promise.reject(new RequestDivergenceError(rpc, expected, actual))
    }

    // drop-ack: the server APPLIED (request was valid, asserted above) but the ack was lost, so reject and the in-flight call fails; the engine retries the identical bytes on the next rpc step and reconciles recorded verdicts (push/003).
    if (active.fault === 'drop-ack') {
      return Promise.reject(new TransportFaultError(rpc))
    }

    // Normal rpc: replay the golden response verbatim. Deep-clone so the engine can never mutate the corpus-derived object underneath a later reader.
    return Promise.resolve(structuredClone(active.response))
  }
}
