<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">@kizunasync/demo</span>
</h1>

Two browser databases, one Supabase, side by side on one page. Each pane is a Kizuna client with its own OPFS SQLite file, its own Supabase client, and the Rust sync engine running as WebAssembly in its own worker. The clients share one authenticated visitor identity on purpose. The column underneath keeps the latest 100 engine events, `kizunasync.pull` / `kizunasync.push` round trips, server verdicts, and scenario notes from both panes in one interleaved ring.

Source for the two-pane demo. The documented path runs against the repository's local Supabase stack. `demo.kizunasync.com` runs against a separate, dedicated Supabase project, and `.github/workflows/deploy-demo.yml` builds and uploads it as one of `release.yml`'s steps on a pushed `v*` tag (see [Public deployment](#public-deployment) below).

## Prerequisites

- Local stack running: `bun run db:start` from the repository root
- Demo fixture in place (`0002_example.sql`). A stack from this repository's `db:start` already has it
- Repo-root environment template filled with the publishable key `bun run db:status` prints:

```bash
cp .env.example .env
```

The Supabase CLI issues a per-stack `sb_publishable_*` key, so the value differs on every machine. It is a local-dev key with no reach beyond your own stack.

## Get started

```bash
bun run dev
```

You should see two panes, each reporting `Online · Not synced yet`, and a wire log that fills as the panes complete their first pull.

The Playwright demo lane (`bun run --filter @kizunasync/web test:browser:demo`) always runs without the Turnstile widget, whatever `VITE_DEMO_TURNSTILE_SITE_KEY` is set to locally.

## What each control demonstrates

**Add, mark done, archive, restore, delete for good** (per row). Ordinary write paths. Add inserts through `kizunasync.from('todos')`. The checkbox flips `done`. Archive sets `archived_at`. Restore clears `archived_at`. Delete-for-good issues a real `DELETE`.

Archive is an ordinary update rather than a tombstone, so the row survives, keeps merging under column-LWW, and stays editable. Every write lands locally first and reaches the other pane through the server. `useQuery` re-reads on every event that can change a row: a committed local write or pull, or a reset/rehydration signal.

**Sync now** (per pane). Pushes the pane's outbox, then pulls: the same round trip the next scheduled sync would run.

**Go offline / Go online** (per pane). Simulated airplane mode. While offline, connectivity reports offline, the realtime doorbell is torn down, and writes accumulate in the SQLite outbox. Going online triggers the engine path that drains queued writes. OPFS persists the database across reloads. The Bun test suite does not execute a real browser or a kill/reload matrix.

**Simulate conflict** (header). Both panes go offline. Each writes a different title to the same column. They reconnect one after the other.

Conflict mode is `arrival`, so pane B, released second, wins the title. Pane A learns it lost on its next pull.

**Simulate edit + soft delete** (header). Pane A marks the shared row done. Pane B archives it.

The two writes touch different columns, so column-LWW keeps both. The item comes back checked and archived, where a whole-row last-write-wins store would have kept only one of the two.

**Try to write someone else's row** (per pane). The board contains one row owned by seeded `mary@kizunasync.local`. The write applies locally. The push carries it. The server answers with a typed rejection. The engine reverts the row, and the rejection lands in the journal `useRejections` reads.

The UPDATE policy is owner-only, and SELECT still admits registered owners' rows. Mary's row is visible because this client declares no bucket, and a pull with no params asks for every row RLS permits.

**Wipe & rehydrate** (per pane). The control calls `client.reset()`, then syncs. The reset clears local Kizuna tables, the outbox, and the cursor. The sync pulls the RLS-visible board again. The control deletes no server rows.

## What the demo proves

Against a running local stack, the demo shows column-LWW on server arrival order, and column-LWW across different columns. It also shows Postgres keeping row authority, with an RLS refusal arriving as a typed verdict the client compensates for. The offline control shows writes remaining queued while connectivity reports offline. Persistence across an actual browser termination is outside this demo's automated evidence.

What it does not show: attachments, buckets, or multi-table configuration. The board is a single table provisioned without a bucket column, so both panes pull with an empty bucket and still get every row RLS permits.

## How it is wired

Each pane composes `createSupabaseKizunaSync({ supabase, driver, config, connectivity, wakeup, logging, refreshOnForeground })` over `createWebWorkerDriver` from `kizunasync/web`, inside its own `KizunaSyncProvider`; `refreshOnForeground` is set only on the session-owner pane. The panes share nothing in React; what they share is the Supabase project underneath.

The wire viewer taps traffic at the supabase-js `fetch` layer, not at `IProtocolRemote`. `createSupabaseKizunaSync` builds its remote internally, so wrapping the remote would mean changing `kizunasync/supabase`. The fetch layer sees the same round trips and measures real serialized bytes. Engine events reach the same log through `client.on(…)`.

Pane A signs in anonymously and pane B adopts that identity, because `public.todos` policies target `authenticated`. The two clients represent one visitor on two devices; only pane A refreshes the shared token. When `pg_cron` is available, a demo job removes an anonymous account once it has been idle for 24 hours. There is no accounts UI: the sessions are plumbing.

## Public deployment

`demo.kizunasync.com` runs against its own Supabase project, kept separate from every other Kizuna project. An abuse spike or a visitor bug on the public demo then stays inside a disposable backend instead of reaching a shared one.

The public project runs the same migrations as the local stack, the base pack `0001_kizuna_init.sql` and the demo fixture `0002_example.sql`. On top of those, it runs one file the local stack never applies, `packages/supabase-pack/supabase/demo/0001_public_demo_hardening.sql`. The maintainer applies that hardening file once, by hand, through the Supabase Management API; it never runs through `supabase db reset`, the local dev stack, or CI.

The hardening file closes what the local-only fixture leaves open on a server the whole internet can reach. The public project refuses email sign-ups and refuses a sign-in as the seeded owner account, so a visitor can still see mary's row for the RLS-refusal demo without ever writing through it. It refuses file uploads: the storage bucket and its write policies from `0002_example.sql` are dropped. It refuses more than 100 todos or 300 writes per minute from one visitor, the same caps `0002_example.sql` already enforces locally. It refuses an anonymous sign-in that carries no Cloudflare Turnstile token, verified by Supabase Auth before a session is issued.

A visitor's account lasts only while it is in use. The demo reaps an anonymous account once it has been idle for six hours, or for one hour when it owns no todos, and takes its rows with it through the same cascade `0002_example.sql` sets up locally. The account's latest token refresh or sync counts as activity, so an open tab keeps its visitor. A visitor who returns after the reap gets a new anonymous account, and each pane wipes its local database and resets itself to that account.

The static build runs on Vercel. `.github/workflows/deploy-demo.yml` uploads it as one of `release.yml`'s steps, once a pushed `v*` tag has run `ci` and `rust-ci` with `full: true`. Vercel reads its routing, headers, and Content-Security-Policy from `public/vercel.json`, scoped to this Supabase project and to Cloudflare Turnstile. That policy also admits Google Tag Manager and Google Analytics; visitors in the EEA, the UK, and Switzerland see a consent banner and are tracked only after they accept.

The Turnstile widget is optional. Set `VITE_DEMO_TURNSTILE_SITE_KEY` to show it. Leave it unset, as the local `.env.example` does, and the demo runs with no widget at all.

## Related

- [The consistency model](../../docs/sync/consistency-model.md)
- [`examples/todo-react`](../../examples/todo-react)
- [Browser conformance / demo lane](../../packages/web/conformance/README.md)
