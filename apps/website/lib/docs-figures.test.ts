/// <reference types="bun" />
/**
 * Docs figures are the public SVGs at apps/website/public/docs/images/.
 * Each one must still exist where markdown embeds it, and must carry the
 * page's claim as visible text, not as decorative shapes alone.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const images = resolve(repo, 'apps/website/public/docs/images')
const docs = resolve(repo, 'docs')

const FIGURES: Array<{
  file: string
  embed: string
  labels: string[]
}> = [
  {
    file: 'kizunasync-flow.svg',
    embed: 'docs/getting-started/introduction.md',
    labels: ['Offline-first sync for Supabase', 'Sarah\'s phone', 'kizunasync', 'Supabase'],
  },
  {
    file: 'sync-loop.svg',
    embed: 'docs/getting-started/how-kizuna-works.md',
    labels: ['Write locally.', 'Push.', 'Pull.', 'Sarah\'s phone', 'local SQLite', 'outbox', 'checkpoint ·', 'seq 41', 'seq 43', 'works on a plane', 'insert · todos', 'applied ✓', 'pull · 2 changes', 'Buy oat milk', 'David', 'Your Supabase project', 'kizunasync.push', 'kizunasync.pull', 'todos · RLS'],
  },
  {
    file: 'architecture-two-halves.svg',
    embed: 'docs/resources/architecture.md',
    labels: ['Two halves.', 'Nothing', 'ON THE DEVICE', 'YOUR SUPABASE PROJECT', 'Your app', 'createKizunaSync / KizunaSyncClient', 'WebAssembly worker', 'N-API', 'UniFFI', 'Rust kernel', 'kizunasync-engine', 'outbox', 'push / pull', 'checkpoint', 'attachment queue', 'local SQLite', 'your tables · RLS', 'kizunasync', 'triggers on synced tables', 'Storage', 'Realtime', 'no Kizuna service', 'push · 3 mutations', 'applied ✓', 'pull · checkpoint', 'bytes', 'wake'],
  },
  {
    file: 'offline-writes.svg',
    embed: 'docs/sync/offline-writes.md',
    labels: ['Writes never', 'wait', 'Sarah\'s phone', 'ONLINE', 'OFFLINE', 'Online', 'Offline', '3 pending', 'Sync now', 'outbox', 'insert · todos', 'update · todos', 'push · 3 mutations', 'applied ✓', 'rejected · RLS_DENIED', 'Write rejected: RLS_DENIED', 'Your Supabase project', 'kizunasync.push', 'todos · RLS'],
  },
  {
    file: 'fencing-horizon.svg',
    embed: 'docs/sync/fencing-and-horizons.md',
    labels: ['Transaction A', 'Transaction B', 'changelog', 'numbered at write time', 'numbered at commit', 'late arrival · skipped', 'consistency horizon', 'cursor'],
  },
  {
    file: 'conflict-columns.svg',
    embed: 'docs/sync/conflict-resolution.md',
    labels: ['Sarah\'s phone', 'David\'s tablet', 'Your Supabase project', 'todos', 'title', 'done', 'notes', '{ title, done }', '{ notes }', 'applied ✓', 'both edits survive', 'later arrival holds the column'],
  },
  {
    file: 'pack-annex.svg',
    embed: 'docs/cli/whats-installed.md',
    labels: ['One schema', 'beside', 'your database', 'public', 'todos', 'profiles', 'track_change', 'track_delete', 'insert', 'Realtime', 'kizunasync:todos', 'kizunasync_rls · NOBYPASSRLS', '_change_pending', '_stamp_change', 'at commit', '_changelog', 'upsert · todos', 'seq 4 · todos', 'attachment_confirm', 'attachment_metadata', 'attachment_vacuum', '_provisions', '_config', '_clients', '_settings', '_tombstones', '_bucket_grants', '_verdicts', '_row_hlc', '_conflict_journal', '_reap_state', 'attachments', 'kizunasync-reap-tombstones', 'kizunasync-compact-changelog', 'kizunasync-prune-clients', 'deprovision --purge'],
  },
]

describe('docs figures', () => {
  for (const figure of FIGURES) {
    test(`${figure.file} is a labeled SVG embedded by ${figure.embed}`, () => {
      const svgPath = resolve(images, figure.file)
      const mdPath = resolve(repo, figure.embed)

      expect(existsSync(svgPath)).toBe(true)
      expect(existsSync(mdPath)).toBe(true)
      const svg = readFileSync(svgPath, 'utf8')
      const md = readFileSync(mdPath, 'utf8')

      expect(svg.includes('<svg')).toBe(true)
      expect(svg.length).toBeGreaterThan(400)
      expect(md.includes(`/docs/images/${figure.file}`)).toBe(true)

      for (const label of figure.labels) {
        expect(svg).toContain(label)
      }
      expect(svg).toContain('#15141f')
      expect(svg.includes('#e5484d') || svg.includes('#b03b3f') || svg.includes('#f0676b')).toBe(true)
    })
  }

  test('kizunasync-flow.svg is the README hero figure', () => {
    const readme = readFileSync(resolve(repo, 'README.md'), 'utf8')

    expect(readme.includes('apps/website/public/docs/images/kizunasync-flow.svg')).toBe(true)
  })

  test('every /docs/images/*.svg embed in docs/ resolves', () => {
    const files = [
      'docs/getting-started/introduction.md',
      'docs/getting-started/how-kizuna-works.md',
      'docs/sync/offline-writes.md',
      'docs/resources/architecture.md',
      'docs/sync/fencing-and-horizons.md',
      'docs/sync/conflict-resolution.md',
      'docs/cli/whats-installed.md',
    ]
    const refs = new Set<string>()

    for (const file of files) {
      const md = readFileSync(resolve(repo, file), 'utf8')

      for (const match of md.matchAll(/\/docs\/images\/([a-z0-9-]+\.svg)/g)) {
        refs.add(match[1]!)
      }
    }
    expect([...refs].sort()).toEqual(FIGURES.map((figure) => figure.file).sort())

    for (const name of refs) {
      expect(existsSync(resolve(images, name))).toBe(true)
    }
    expect(existsSync(docs)).toBe(true)
  })
})
