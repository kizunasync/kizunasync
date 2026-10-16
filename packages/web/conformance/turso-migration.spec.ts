import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { callEngineOn, closeEngines, openEngine, openEngineExpectingFailure, PAGE_PATH, readRowIds, readStoreKindOn } from './harness'

const fixture = (name: string): number[] =>
  Array.from(
    readFileSync(
      new URL(
        `../../../crates/kizunasync-store/tests/fixtures/${name}`,
        import.meta.url,
      ),
    ),
  )

async function seed(
  page: Page,
  name: string,
  backend: 'opfs' | 'idb',
  dirty = false,
): Promise<void> {
  const files = [
    {
      suffix: '',
      bytes: fixture(dirty ? 'dirty-wal.fixture' : 'closed.fixture'),
    },
  ]

  if (dirty)
    files.push({ suffix: '-wal', bytes: fixture('dirty-wal.fixture-wal') })
  await page.evaluate(
    (data) =>
      new Promise<void>((resolve, reject) => {
        const worker = new Worker('/legacy-storage-worker.js', {
          type: 'module',
        })

        worker.onerror = (error) => {
          worker.terminate()
          reject(new Error(error.message))
        }
        worker.onmessage = ({ data: result }) => {
          worker.terminate()

          if (result.ok) resolve()
          else reject(new Error(result.message))
        }
        worker.postMessage(data)
      }),
    { name, backend, files },
  )
}

for (const [backend, dirty] of [
  ['opfs', false],
  ['opfs', true],
  ['idb', false],
] as const) {
  test(`imports ${backend} ${dirty ? 'committed WAL' : 'database'} and preserves pending offline data across reload`, async ({
    page,
  }) => {
    const name = `legacy-${backend}-${dirty}`

    await page.goto(PAGE_PATH)
    await seed(page, name, backend, dirty)
    await openEngine(page, { name, databasePath: name, table: 'todos' })
    expect(await callEngineOn(page, name, 'store_kind')).toMatchObject({
      engine: 'turso',
    })
    expect(await callEngineOn(page, name, 'outbox_depth')).toBe(9)
    expect(await callEngineOn(page, name, 'checkpoint')).toMatchObject({
      cursor: '900719925474099312345',
    })
    expect(await readRowIds(page, name, 'todos')).toHaveLength(10)
    expect(
      await callEngineOn(page, name, 'attachment_get', {
        reference: 'attachment-1',
      }),
    ).toMatchObject({
      chunk_offset: 6291456,
      tus_url: 'https://example.invalid/synthetic-upload',
    })
    await closeEngines(page)
    await page.reload()
    await openEngine(page, { name, databasePath: name, table: 'todos' })
    expect(await readRowIds(page, name, 'todos')).toHaveLength(10)
    expect(await callEngineOn(page, name, 'outbox_depth')).toBe(9)
    expect(await readStoreKindOn(page, name)).toMatchObject({
      kind: backend === 'opfs' ? 'opfs-sahpool' : 'relaxed-idb',
    })
  })
}

test('refuses divergent legacy backends instead of choosing one and hiding pending edits', async ({
  page,
}) => {
  const name = 'legacy-divergent'

  await page.goto(PAGE_PATH)
  await seed(page, name, 'opfs')
  await seed(page, name, 'idb')
  const error = await openEngineExpectingFailure(page, {
    name,
    databasePath: name,
    table: 'todos',
  })

  expect(error?.code).toBe('STORE_UNAVAILABLE')
  expect(error?.message).toContain('reconcile')
})
