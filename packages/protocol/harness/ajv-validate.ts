// MARK: - ajv-backed schema conformance

/**
 * @kizunasync/protocol ships zero RUNTIME dependencies; ajv is a devDependency run at
 * test/build time only [CONV:repository-layout → "zero runtime deps; dev/build tooling permitted"].
 * One Ajv 2020 instance registers all 7 standardized schemas so cross-file
 * "common.schema.json#/$defs/<name>" refs resolve by $id. The kizuna* annotation
 * keywords (kizunaCites/kizunaNote/kizunaStatus/kizunaOpen) carry no validation
 * semantics and are declared so strict mode tolerates them without silent fallbacks.
 */
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020'
import common from '../schemas/common.schema.json'
import manifest from '../schemas/manifest.schema.json'
import pullRequest from '../schemas/pull-request.schema.json'
import pullResponse from '../schemas/pull-response.schema.json'
import pushRequest from '../schemas/push-request.schema.json'
import pushResponse from '../schemas/push-response.schema.json'
import transcript from '../schemas/transcript.schema.json'

// MARK: - Public types

export type TValidationIssue = { path: string; message: string }

const BASE = 'https://schemas.kizunasync.dev'

const SCHEMA_IDS = {
  common: `${BASE}/common.schema.json`,
  manifest: `${BASE}/manifest.schema.json`,
  'pull-request': `${BASE}/pull-request.schema.json`,
  'pull-response': `${BASE}/pull-response.schema.json`,
  'push-request': `${BASE}/push-request.schema.json`,
  'push-response': `${BASE}/push-response.schema.json`,
  transcript: `${BASE}/transcript.schema.json`,
} as const

// MARK: - Ajv instance

const WIRE_ANNOTATION_KEYWORDS = ['kizunaCites', 'kizunaNote', 'kizunaOpen', 'kizunaStatus'] as const

/**
 * RFC-4122 textual form. Registered explicitly because ajv ships no format
 * vocabulary: an unregistered `format` is ignored, and a declared constraint
 * nothing enforces is the silent fallback the protocol forbids.
 */
const UUID_FORMAT = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

const buildAjv = (): Ajv2020 => {
  const ajv = new Ajv2020({ allErrors: true, strict: false })

  for (const keyword of WIRE_ANNOTATION_KEYWORDS) {
    ajv.addKeyword({ keyword })
  }
  ajv.addFormat('uuid', UUID_FORMAT)
  // common first so cross-file refs from the others resolve at addSchema time.
  ajv.addSchema([common, manifest, pullRequest, pullResponse, pushRequest, pushResponse, transcript])

  return ajv
}

const ajv = buildAjv()

// MARK: - Issue mapping

const toIssue = (error: ErrorObject): TValidationIssue => ({
  path: error.instancePath,
  message: `${error.message ?? 'invalid'}${error.keyword === 'additionalProperties' ? ` "${String(error.params.additionalProperty)}"` : ''}`,
})

const resolveValidator = (schemaId: string): ValidateFunction => {
  const id = schemaId.startsWith('http') ? schemaId : SCHEMA_IDS[schemaId as keyof typeof SCHEMA_IDS]

  if (id === undefined) {
    throw new Error(`ajv-validate: unknown schema id "${schemaId}" (closed set)`)
  }
  const validator = ajv.getSchema(id)

  if (validator === undefined) {
    throw new Error(`ajv-validate: schema "${id}" not registered`)
  }
  return validator
}

// MARK: - Public API

export const validateAgainst = (schemaId: string, value: unknown): TValidationIssue[] => {
  const validator = resolveValidator(schemaId)

  return validator(value) ? [] : (validator.errors ?? []).map(toIssue)
}
