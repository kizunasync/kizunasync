<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">example: todo-react</span>
</h1>

Private workspace. React 19 and Vite 8 browser example for the source checkout. Normal todo reads and writes go through Kizuna's local query app client; `supabase-js` supplies authentication and the Supabase adapters. The edge-case lab's `force conflict` action is the deliberate exception: it writes directly to Supabase so the local client can reconcile a conflicting server value.

The browser opens `createWebWorkerDriver`, which runs the Rust engine as WebAssembly in a dedicated worker. The database persists through the OPFS synchronous-access-handle pool, or through the relaxed IndexedDB store where that pool is unavailable. One tab per database leads the engine; the others reach it over a BroadcastChannel. No SharedArrayBuffer, no COOP/COEP headers.

## Visibility and ownership

The client declares `todos` without a client-side bucket, so it requests every row that Supabase [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) permits. RLS remains the authorization boundary.

With the current local demo fixtures:

- Every visitor sees every todo, anonymous-owned or registered
- An anonymous visitor's rows accept edits and deletes from any other visitor
- Mary, Samuel, and David's rows stay readable by everyone but writable only by their owner. "Test non-owner edit" lifts the local guard on those rows so a non-owner write can show the `RLS_DENIED` revert
- Switching accounts signs in as the new identity, resets the local cache, and pulls the RLS-visible set again

These rules come from the demo-only `0002_example.sql` migration. They are not part of Kizuna's installable SQL pack.

## What it demonstrates

- Local-first queries and mutations through `@kizunasync/react` (`KizunaSyncProvider`, `useQuery`, `useMutation`, `useSyncStatus`, `useAttachment`, `useRejections`, `useOverwrites`)
- Durable local SQLite state and an outbox that queues under the simulated-offline gate
- Realtime wakeups and the engine pushing a local write on its own after a short debounce, behind a Live sync setting: when it is on, the app syncs by itself as you make changes and on a timer, and when it is off, it syncs only when you press "sync now"
- Image attachments staged in OPFS and transferred through Supabase Storage
- Account switching, registered-owner RLS rejection, checkpoint rewind, local reset, query logging, engine-event inspection
- Journal count badges and a reset banner when `useSyncStatus` reports `needsReset`

## Prerequisites

- Bun `1.4.2`, as pinned by the repository
- Docker (or another daemon supported by the repository's Supabase CLI setup)
- This monorepo checkout (`@kizunasync/*` via `workspace:*`)

## Get started

From the repository root:

```bash
bun install
bun run db:start
bun run db:status
cp .env.example .env
```

Put the API URL and publishable key from `db:status` in the repo-root `.env`:

```dotenv
VITE_TODO_REACT_SUPABASE_URL=http://127.0.0.1:55321
VITE_TODO_REACT_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Never place a service-role key in this browser application.

```bash
bun run --filter=@kizunasync/example-todo-react dev
```

Open the URL Vite prints. Studio is at `http://127.0.0.1:55323` while the stack is running.

## What to try

1. Let the app create or recover its anonymous session, then add a todo with an image. The row appears from local SQLite before synchronization completes.
2. Enable "Offline (simulated)", add or edit a todo, watch outbox depth, then return online or press sync.
3. Open a separate browser profile with a fresh anonymous session. It receives the first visitor's rows too, since the board is shared.
4. Sign in as Mary (`mary@kizunasync.local` / `kizunasync-demo`), create a todo, switch back to Anonymous, enable "Test non-owner edit", and edit it to exercise RLS rejection on a registered owner's row.
5. Sign in as the same registered account in a second client for same-owner convergence.
6. Treat `force conflict`, `expire checkpoint`, and `reset local` as lab controls only.

## Integration points

[`src/kizunasync.ts`](./src/kizunasync.ts) owns the table declaration, browser driver, Supabase composition, attachment ports, live-sync gates, and lab controls. [`src/app.tsx`](./src/app.tsx) creates the provider after the memoized client opens. [`src/components/todo-board.tsx`](./src/components/todo-board.tsx) is the hook-driven board.

```ts
const config = defineConfig<TTodoDatabase>({
  tables: {
    todos: {
      sync: 'read-write',
      attachments: { image_path: attachment('todos', { ownerColumn: 'user_id' }) },
    },
  },
})
```

A bucketless declaration expands only to rows already permitted by RLS.

## Tests

```bash
bun run cargo:napi
bun test examples/todo-react
```

Build the N-API addon first. The suite exercises the documented client over an in-memory SQLite driver and a fake protocol remote. It is not a browser test and does not verify OPFS, Auth, live RLS, Storage, Realtime, multi-tab behavior, or process termination.

| Command | Script |
|---|---|
| `bun run build` | `tsc -b && vite build` |
| `bun run preview` | `vite preview` |
| `bun run type-check` | `tsc -b` |
| `bun run test` | `bun test` |

## Related

- [React guide](../../docs/getting-started/react.md)
- [Quickstart](../../docs/getting-started/quickstart.md)
- [Local Supabase setup](../../docs/cli/local-supabase.md)
- [Offline writes](../../docs/sync/offline-writes.md)
- [Media and attachments](../../docs/attachments/media-and-attachments.md)
- [Sync rules and buckets](../../docs/sync/sync-rules-and-buckets.md)
