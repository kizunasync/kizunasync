<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">example: todo-vue</span>
</h1>

Private workspace. Vue 3 and Vite 8 counterpart to the React browser example. Normal todo reads and writes go through the Kizuna client and `kizunasync/vue` composables; `supabase-js` supplies authentication and the Supabase adapters. The lab's direct server-conflict action intentionally bypasses the local app client so reconciliation has a conflicting value to process.

The app opens `createWebWorkerDriver`, which runs the Rust engine as WebAssembly in a dedicated worker. The database persists through the OPFS pool or the relaxed IndexedDB store. One tab per database leads the engine; the others reach it over a BroadcastChannel. No SharedArrayBuffer, no COOP/COEP headers.

## Visibility and ownership

The client declares `todos` without a client-side bucket and asks for the complete set [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) permits. Supabase RLS decides which rows are visible and writable.

With the current local demo fixtures:

- Every visitor sees every row, anonymous-owned or registered
- An anonymous visitor's rows accept edits and deletes from any other visitor
- Registered demo rows stay readable by everyone but writable only by their owner, for an explicit non-owner rejection exercise. "Test non-owner edit" enables UI controls but cannot bypass RLS
- An account switch signs in again, clears the previous identity's local cache, and rehydrates the new RLS-visible set

These policies come from demo-only `0002_example.sql`, not from the installable Kizuna pack.

## What it demonstrates

- Reactive local queries with `useQuery`, mutation queueing, sync status, attachment resolution, and both durable journals through `kizunasync/vue`
- Journal count badges and a reset banner when `useSyncStatus` reports `needsReset`
- A memoized worker client, OPFS persistence, Realtime wakeups, and the engine pushing a local write on its own after a short debounce
- A Live sync setting: when it is on, the app syncs by itself as you make changes and on a timer, and when it is off, it syncs only when you press "sync now"
- Image attachment staging and upload through the file-store and Supabase transfer ports
- Session recovery, account switching, simulated offline mode, registered-owner RLS reconciliation, checkpoint rewind, local reset, query logging, engine-event inspection

## Prerequisites

- Bun `1.4.2`, as pinned at the repository root
- Docker (or another daemon supported by the local Supabase setup)
- This monorepo checkout (`kizunasync` via `workspace:*`)

## Get started

From the repository root:

```bash
bun install
bun run db:start
bun run db:status
cp .env.example .env
```

Fill the repo-root `.env` with the API URL and publishable key from `db:status`:

```dotenv
VITE_TODO_VUE_SUPABASE_URL=http://127.0.0.1:55321
VITE_TODO_VUE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Do not expose a service-role key in this browser application.

```bash
bun run --filter=@kizunasync/example-todo-vue dev
```

Open the URL Vite prints. Studio is at `http://127.0.0.1:55323` while the stack is running.

## What to try

1. Let the app recover or create an anonymous session, then add a todo. The Vue view reads the new row from local SQLite immediately.
2. Enable "Offline (simulated)", add or edit a todo, watch the queued [outbox](../../docs/resources/glossary.md#outbox), then return online or use sync.
3. Open a different browser profile as a fresh anonymous visitor. It receives the first visitor's rows too, since the board is shared.
4. Sign in as Mary (`mary@kizunasync.local` / `kizunasync-demo`), create a row, switch to Anonymous, enable "Test non-owner edit", and mutate it to see the registered-owner refusal.
5. Use the same registered account in two clients for same-owner synchronization.
6. Treat `force conflict`, `expire checkpoint`, and `reset local` as development controls.

## Integration points

[`src/kizunasync.ts`](./src/kizunasync.ts) defines the table, driver, file store, Supabase composition, live-sync gate, and lab helpers. [`src/App.vue`](./src/App.vue) boots the client. [`src/components/TodoView.vue`](./src/components/TodoView.vue) uses the composables.

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

## Tests

```bash
bun run cargo:napi
bun test examples/todo-vue
```

Build the N-API addon first. The suite runs the documented client over an in-memory SQLite driver and a fake protocol remote. It does not run Vue, Vite, OPFS, Auth, live RLS, Storage, Realtime, a real browser, or a process-termination test.

| Command | Script |
|---|---|
| `bun run build` | `node scripts/vue-tsc.cjs -b && vite build` |
| `bun run preview` | `vite preview` |
| `bun run type-check` | `node scripts/vue-tsc.cjs -b` |
| `bun run test` | `bun test` |

## Related

- [Vue guide](../../docs/getting-started/vue.md)
- [Quickstart](../../docs/getting-started/quickstart.md)
- [Local Supabase setup](../../docs/cli/local-supabase.md)
- [Offline writes](../../docs/sync/offline-writes.md)
- [Media and attachments](../../docs/attachments/media-and-attachments.md)
- [Test offline behavior](../../docs/operations/test-offline-behavior.md)
