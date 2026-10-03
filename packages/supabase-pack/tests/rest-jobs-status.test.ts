/**
 * kizunasync.jobs_status over the Data API. The sync inspector reads it
 * server-side with a service-role key; `cron` is not an exposed schema. The
 * service key gets the rows; every client key gets 42501.
 *
 * This lane talks to the stack's HTTP API and always hits the database that
 * API serves, whatever SUPABASE_DB_URL points at. Keys are never hardcoded
 * (@../../../CONVENTIONS.md): supply them from `supabase status`. The lane
 * skips with a named reason when they are absent.
 */

import { describe, expect, test } from 'bun:test'

const API_URL = process.env.SUPABASE_API_URL ?? 'http://127.0.0.1:55321'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? ''
const CLIENT_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? ''

const configured = SERVICE_KEY !== '' && CLIENT_KEY !== ''
let reachable = false

if (configured) {
  try {
    const probe = await fetch(`${API_URL}/rest/v1/`, { headers: { apikey: CLIENT_KEY } })

    reachable = probe.ok || probe.status === 404
  } catch {
    reachable = false
  }
}

if (!configured) {
  console.warn(
    '[rest-jobs-status] SKIPPED: set SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) and ' +
      'SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY) from `supabase status` to exercise the ' +
      'Data API lane. The database-level guard cases in settings-schedules.test.ts still run.',
  )
} else if (!reachable) {
  console.warn(`[rest-jobs-status] SKIPPED: no Supabase API at ${API_URL}. Run \`bun run db:start\`.`)
}

interface IJobRow {
  jobname: string
  schedule: string
  active: boolean
}

const callJobsStatus = async (key: string): Promise<{ status: number; body: unknown }> => {
  const response = await fetch(`${API_URL}/rest/v1/rpc/jobs_status`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Profile': 'kizunasync',
      'Content-Type': 'application/json',
    },
    body: '{}',
  })

  return { status: response.status, body: await response.json() }
}

describe.skipIf(!configured || !reachable)('kizunasync.jobs_status over the Data API', () => {
  test('the service key reads the pack jobs', async () => {
    const { status, body } = await callJobsStatus(SERVICE_KEY)

    expect(status).toBe(200)
    const rows = body as IJobRow[]

    expect(Array.isArray(rows)).toBe(true)

    // No pg_cron on the server means no jobs to report, which is a valid answer.
    if (rows.length > 0) {
      expect(rows.map((r) => r.jobname)).toEqual([
        'kizunasync-compact-changelog',
        'kizunasync-prune-clients',
        'kizunasync-reap-tombstones',
      ])
      expect(rows.every((r) => r.active)).toBe(true)
      expect(rows.every((r) => typeof r.schedule === 'string' && r.schedule.split(' ').length === 5)).toBe(true)
    }
  })

  test('a client key is refused with 42501', async () => {
    const { status, body } = await callJobsStatus(CLIENT_KEY)

    expect(status).not.toBe(200)
    expect(JSON.stringify(body)).toContain('42501')
  })
})
