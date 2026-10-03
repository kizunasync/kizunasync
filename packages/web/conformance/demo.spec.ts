import { expect, test } from '@playwright/test'

// MARK: - The demo, on the engine it claims to run

/**
 * `apps/demo` is the page a reader is pointed at. The status strip must name the
 * core answering the pane, and a row typed into it must still be on the board
 * after a reload.
 *
 * Needs the stack; the `demo` project keeps that requirement off the hermetic
 * lane. The demo's boot signs in anonymously, stages a row owned by the seeded
 * fixture user, and syncs both panes before it renders anything, so it needs the
 * local Supabase stack (`bun run db:start`) and the repo-root demo keys. Locally
 * that is `test:browser:demo`, which sets `KSYNC_DEMO_LANE=1`. In CI it is the
 * `db-tests` job of ci.yml, which starts the stack and writes those keys first.
 *
 * The reload proves the row is on the board after the page is torn down and
 * rebuilt. It does not isolate the local store as the source: the rebuilt client
 * also pulls, and a row that reached the server would come back that way too.
 * Proving the store alone would mean writing while the pane is switched offline,
 * a different test than this lane.
 */

/**
 * Both panes carry it, and each opens its own database. The engine kind is
 * asserted on both, not on whichever one rendered first.
 */
const PANES = ['A', 'B'] as const

/**
 * The demo boots through sign-in, a staged fixture row, and two syncs before the
 * panes exist, so the first paint is a network round trip, not a render.
 */
const BOOT_TIMEOUT_MS = 120_000

test('the demo runs the Rust engine and keeps a todo across a reload', async ({ page }) => {
  const crashes: string[] = []

  page.on('pageerror', (error) => {
    crashes.push(error.message)
  })

  const paneA = page.getByRole('region', { name: 'Pane A' })
  const title = `playwright ${Date.now().toString(36)}`

  await page.goto('/')
  await expect(paneA).toBeVisible({ timeout: BOOT_TIMEOUT_MS })

  for (const pane of PANES) {
    await expect(page.getByRole('region', { name: `Pane ${pane}` })).toContainText('rust engine')
  }

  await paneA.getByLabel('Add a todo in pane A').fill(title)
  await paneA.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(paneA.getByRole('button', { name: `Toggle ${title}` })).toBeVisible()

  await page.reload()
  await expect(paneA).toBeVisible({ timeout: BOOT_TIMEOUT_MS })

  await expect(paneA.getByRole('button', { name: `Toggle ${title}` })).toBeVisible()
  await expect(paneA).toContainText('rust engine')

  expect(crashes).toEqual([])
})
