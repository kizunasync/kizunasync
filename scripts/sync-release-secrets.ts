/**
 * sync-release-secrets: push the release credentials from a local, gitignored
 * env file into the `kizunasync/kizunasync` GitHub Actions secrets, and
 * optionally add the Sonatype namespace-verification TXT record on Cloudflare.
 * Never prints a secret value. Run from the repository root:
 *
 *   bun scripts/sync-release-secrets.ts [--dry-run] [--env .env.prod] [--sonatype-key <verification-key>]
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const GITHUB_REPO = 'kizunasync/kizunasync'
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'
const CLOUDFLARE_ZONE_NAME = 'kizunasync.com'

/** In sync order; each is skipped when its env value is empty. */
const SECRET_NAMES = [
  'MAVEN_CENTRAL_USERNAME',
  'MAVEN_CENTRAL_PASSWORD',
  'MAVEN_SIGNING_KEY',
  'MAVEN_SIGNING_KEY_ID',
  'MAVEN_SIGNING_PASSWORD',
  'KSYNC_SWIFT_DEPLOY_KEY',
] as const

// MARK: - CLI args

interface ICliArgs {
  dryRun: boolean
  envPath: string
  sonatypeKey?: string
}

function usageAndExit(message?: string): never {
  if (message !== undefined) {
    console.error(message)
  }
  console.error('usage: bun scripts/sync-release-secrets.ts [--dry-run] [--env .env.prod] [--sonatype-key <verification-key>]')
  process.exit(2)
}

/** Prints `message` and exits 1; for runtime failures, as opposed to `usageAndExit`'s CLI-usage errors. */
function failWith(message: string): never {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv: string[]): ICliArgs {
  let dryRun = false
  let envPath = '.env.prod'
  let sonatypeKey: string | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--env') {
      i += 1
      const value = argv[i]

      if (value === undefined) {
        usageAndExit('--env requires a file path argument')
      }
      envPath = value
    } else if (arg === '--sonatype-key') {
      i += 1
      const value = argv[i]

      if (value === undefined) {
        usageAndExit('--sonatype-key requires a value')
      }
      sonatypeKey = value
    } else {
      usageAndExit(`unknown argument: ${arg}`)
    }
  }

  return { dryRun, envPath, sonatypeKey }
}

// MARK: - Env file parsing

type TEnvMap = Record<string, string>

function stripQuotes(value: string): string {
  const isQuoted = value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))

  return isQuoted ? value.slice(1, -1) : value
}

function parseEnvFile(path: string): TEnvMap {
  if (!existsSync(path)) {
    failWith(`env file not found: ${path}`)
  }

  const values: TEnvMap = {}

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()

    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue
    }
    const separatorIndex = trimmed.indexOf('=')

    if (separatorIndex === -1) {
      continue
    }
    const key = trimmed.slice(0, separatorIndex).trim()

    values[key] = stripQuotes(trimmed.slice(separatorIndex + 1).trim())
  }
  return values
}

// MARK: - GitHub Actions secrets

function setGithubSecret(name: string, value: string): void {
  const result = spawnSync('gh', ['secret', 'set', name, '-R', GITHUB_REPO], { input: value, encoding: 'utf8' })

  if (result.status !== 0) {
    failWith(`gh secret set ${name} failed: ${result.stderr.trim()}`)
  }
  console.log(`set ${name}`)
}

function syncGithubSecrets(envValues: TEnvMap, dryRun: boolean): boolean {
  let usedGh = false

  for (const name of SECRET_NAMES) {
    const value = envValues[name]

    if (value === undefined || value.length === 0) {
      console.log(`skip ${name} (empty)`)
      continue
    }
    if (dryRun) {
      console.log(`would set ${name}`)
      continue
    }
    setGithubSecret(name, value)
    usedGh = true
  }
  return usedGh
}

function printGithubSecretNames(): void {
  const result = spawnSync('gh', ['secret', 'list', '-R', GITHUB_REPO], { encoding: 'utf8' })

  if (result.status !== 0) {
    failWith(`gh secret list failed: ${result.stderr.trim()}`)
  }
  for (const line of result.stdout.split('\n')) {
    if (line.trim().length === 0) {
      continue
    }
    console.log(line.split('\t')[0])
  }
}

// MARK: - Cloudflare Sonatype TXT record

interface ICloudflareEnvelope {
  success: boolean
  result: unknown
  errors: Array<{ code: number; message: string }>
}

function isCloudflareEnvelope(value: unknown): value is ICloudflareEnvelope {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>

  return typeof candidate.success === 'boolean' && Array.isArray(candidate.errors)
}

async function cloudflareRequest(path: string, token: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  })
  const body: unknown = await response.json()

  if (!isCloudflareEnvelope(body) || !body.success) {
    const detail = isCloudflareEnvelope(body) ? body.errors.map((error) => error.message).join('; ') : `HTTP ${String(response.status)}`

    failWith(`Cloudflare API request to ${path} failed: ${detail}`)
  }
  return body.result
}

interface ICloudflareZone {
  id: string
}

function isCloudflareZone(value: unknown): value is ICloudflareZone {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).id === 'string'
}

async function lookupZoneId(token: string): Promise<string> {
  const result = await cloudflareRequest(`/zones?name=${CLOUDFLARE_ZONE_NAME}`, token)
  const zone = Array.isArray(result) ? result[0] : undefined

  if (!isCloudflareZone(zone)) {
    failWith(`Cloudflare zone ${CLOUDFLARE_ZONE_NAME} not found`)
  }
  return zone.id
}

interface ICloudflareDnsRecord {
  content: string
}

function isCloudflareDnsRecord(value: unknown): value is ICloudflareDnsRecord {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).content === 'string'
}

async function hasMatchingTxtRecord(zoneId: string, token: string, key: string): Promise<boolean> {
  const result = await cloudflareRequest(`/zones/${zoneId}/dns_records?type=TXT&name=${CLOUDFLARE_ZONE_NAME}`, token)

  if (!Array.isArray(result)) {
    failWith('Cloudflare DNS records response was not a list')
  }
  return result.some((record) => isCloudflareDnsRecord(record) && stripQuotes(record.content) === key)
}

async function createTxtRecord(zoneId: string, token: string, key: string): Promise<void> {
  await cloudflareRequest(`/zones/${zoneId}/dns_records`, token, {
    method: 'POST',
    body: JSON.stringify({ type: 'TXT', name: '@', content: key, ttl: 1 }),
  })
}

/**
 * The "already present" branch only ever reads Cloudflare state, so it prints
 * the same message in both modes; only the creating branch's POST is skipped
 * under `--dry-run`.
 */
async function syncSonatypeTxtRecord(sonatypeKey: string, cloudflareToken: string, dryRun: boolean): Promise<void> {
  const zoneId = await lookupZoneId(cloudflareToken)

  if (await hasMatchingTxtRecord(zoneId, cloudflareToken, sonatypeKey)) {
    console.log('txt record already present')

    return
  }
  if (dryRun) {
    console.log('would create txt record')

    return
  }
  await createTxtRecord(zoneId, cloudflareToken, sonatypeKey)
  console.log('txt record created')
}

// MARK: - main

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const envValues = parseEnvFile(args.envPath)

  const usedGh = syncGithubSecrets(envValues, args.dryRun)

  if (args.sonatypeKey !== undefined) {
    const cloudflareToken = envValues.CLOUDFLARE_API_TOKEN

    if (cloudflareToken === undefined || cloudflareToken.length === 0) {
      failWith('CLOUDFLARE_API_TOKEN is required in the env file to use --sonatype-key')
    }
    await syncSonatypeTxtRecord(args.sonatypeKey, cloudflareToken, args.dryRun)
  }

  console.log('done')

  if (usedGh) {
    printGithubSecretNames()
  }
}

await main()
