import { DESCRIPTION, GITHUB_URL, SITE_FULL_NAME, SITE_URL } from '@/lib/site'

/** Makes the site legible to AI assistants by serving a structured plain-text index. */

// MARK: - llms.txt

export function GET(): Response {
  const body = `# ${SITE_FULL_NAME}

> ${DESCRIPTION}

Status: Alpha.

Kizuna (絆, "bond"; pronounced kee-zoo-nah) is a library giving Supabase apps
offline-first sync of rows and media. The repository implements the Rust engine,
local query app client, web and Expo drivers, React and Vue bindings, Supabase adapters,
a UniFFI crate with generated Swift and Kotlin source (\`KizunaSyncClient\`), the SQL pack, protocol corpus, CLI,
inspector, and five examples.

The product is three layers: Rust kernel (\`kizunasync-engine\`), language bridges (UniFFI, N-API and wasm),
and peer app clients (\`createKizunaSync\` in JavaScript, \`KizunaSyncClient\` in Swift and Kotlin).
\`selectEngine\` is JavaScript-only. There is no public Rust app SDK.

The product CLI is \`kizunasync\`. Invoke it with \`npx kizunasync\`, \`pnpm dlx kizunasync\`,
\`yarn dlx kizunasync\`, or \`bunx kizunasync\`, never \`target/debug/kizunasync\`.

Install: npm \`kizunasync\` (CLI, JavaScript entry points, React Native module), Swift package \`https://github.com/kizunasync/kizunasync-swift\` (product \`KizunaSync\`), Maven \`com.kizunasync:kizunasync\`.

The SQL pack provisions triggers, private bookkeeping, five authenticated RPCs, guarded
retention jobs, and a Realtime wake-up into the customer's Supabase project. No
Kizuna-operated service sits in the sync data path. Availability still depends on the
customer's Supabase project, network, client, local driver, and configured retention.

Consistency model: causal+ consistency to checkpoints, all four session guarantees per
device, column-level LWW ordered by accepted server arrival by default, and an optional
clamped-HLC table mode. Optional update transforms (increment, arrayUnion, arrayRemove)
apply at the Postgres arbiter, not as CRDTs. An opt-in conflict journal can ride
pull as optional conflicts. Public RPCs use SECURITY DEFINER for private bookkeeping, while
user-row work is delegated through a non-BYPASSRLS role under the caller's JWT. Buckets
select rows; RLS and grants authorize them. These claims are scoped by the documented
retention, visibility, driver, and test boundaries.

Attachments use standard Supabase Storage upload through 6 MiB and resumable TUS in 6 MiB
chunks above that threshold. The source contains mocked coverage and opt-in live tests; a
normal test run is not proof of a hosted or physical-device transfer.

Licensing: the engine, drivers, bindings, CLI, website, examples, protocol corpus, and
inspector declare Apache-2.0. The server SQL pack declares PolyForm Shield 1.0.0. The
read-only inspector exists in the repository, but its deployment workflow is not active.

## For AI coding agents

If you are an AI agent or coding assistant setting up Kizuna for a human,
**start here (ordered, machine-oriented):**

- [Bot / AI agent setup guide (raw markdown)](${SITE_URL}/agent-setup.md)
- [Same guide (HTML docs)](${SITE_URL}/docs/agent-setup)

There is no current Kizuna cloud account or Kizuna API key. Preview the CLI plan
(\`npx kizunasync init --dry-run\` or the equivalent pnpm/yarn/bun runner), provision the SQL
pack into the user's Supabase project, then wire \`createSupabaseKizunaSync\` or \`createKizunaSync\`
for JavaScript, or \`KizunaSyncClient\` for Swift/Kotlin. See the client library reference (same page slugs in every language).

## Links

- [Docs (human-first)](${SITE_URL}/docs). Getting started, sync, attachments, CLI, operations, API reference, and resources
- [Repository layout](${SITE_URL}/docs/repository-layout)

## Client library reference

- [Swift](${SITE_URL}/docs/reference/swift/introduction)
- [Kotlin](${SITE_URL}/docs/reference/kotlin/introduction)
- [JavaScript](${SITE_URL}/docs/reference/javascript/introduction)
- [React](${SITE_URL}/docs/reference/react/introduction)
- [Vue](${SITE_URL}/docs/reference/vue/introduction)
- [Expo](${SITE_URL}/docs/reference/expo/introduction)

- [Quickstart](${SITE_URL}/docs/quickstart)
- [Compare](${SITE_URL}/compare). Architecture matrix with dated primary-source links
- [GitHub](${GITHUB_URL})
- [Wire protocol corpus](${GITHUB_URL}/tree/main/packages/protocol)
- [Governance and licensing commitments](${GITHUB_URL}/blob/main/GOVERNANCE.md)
- [Website](${SITE_URL})
`

  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}
