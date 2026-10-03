import { GITHUB_URL } from './site'
import { referenceRouteForFile } from './reference-registry'

/**
 * Docs registry (pure data, safe for client components).
 *
 * The site renders the repo's public markdown in-place: pages under `/docs`
 * plus the root @../../../GOVERNANCE.md. Slugs are stable URLs; order drives
 * the sidebar and prev/next. Optional `subgroup` nests sidebar sections inside
 * a product area. Filesystem reading lives in `lib/docs.ts` (server-only).
 * `packages/protocol/` is the machine-checkable protocol source of truth.
 */

// MARK: - Docs registry

export interface IDocEntry {
  slug: string
  file: string
  title: string
  group: string
  subgroup?: string
  description: string

  /** Omit from sidebar, mobile nav, prev/next, and docs hub cards. URL stays live for agents. */
  navHidden?: boolean
}

export interface IDocNavEntry extends IDocEntry {
  href: string
  status?: string
}

export const DOCS: IDocEntry[] = [
  // MARK: - Getting started
  {
    slug: 'introduction',
    file: 'docs/getting-started/introduction.md',
    title: 'Introduction',
    group: 'Getting started',
    description: 'What Kizuna is, how it fits a Supabase app, and when to use something else',
  },
  {
    slug: 'quickstart',
    file: 'docs/getting-started/quickstart.md',
    title: 'Quick start',
    group: 'Getting started',
    description: 'Provision your Supabase app with kizunasync from the terminal',
  },
  {
    slug: 'how-kizuna-works',
    file: 'docs/getting-started/how-kizuna-works.md',
    title: 'How Kizuna works',
    group: 'Getting started',
    description: 'Outbox, pull, verdicts, and files',
  },
  {
    slug: 'playground',
    file: 'docs/getting-started/playground.md',
    title: 'Playground',
    group: 'Getting started',
    description: 'Hosted demo plus in-repository reference apps',
  },
  {
    slug: 'agent-setup',
    file: 'docs/getting-started/agent-setup.md',
    title: 'Bot / AI agent setup',
    group: 'Getting started',
    description: 'Ordered, machine-oriented setup for coding agents; no Kizuna account exists',
    navHidden: true,
  },
  {
    slug: 'status',
    file: 'docs/getting-started/status.md',
    title: 'Project status',
    group: 'Getting started',
    description: 'What is implemented, verified, limited, and planned',
  },
  {
    slug: 'react',
    file: 'docs/getting-started/react.md',
    title: 'React',
    group: 'Getting started',
    subgroup: 'Frameworks',
    description: 'Wire KizunaSyncProvider and the useQuery, useMutation, useSyncStatus, and useAttachment hooks into a React app',
  },
  {
    slug: 'vue',
    file: 'docs/getting-started/vue.md',
    title: 'Vue',
    group: 'Getting started',
    subgroup: 'Frameworks',
    description: 'Provide the @kizunasync/vue composables and read, write, and track sync status in a Vue 3 app',
  },
  {
    slug: 'expo',
    file: 'docs/getting-started/expo.md',
    title: 'Expo / React Native',
    group: 'Getting started',
    subgroup: 'Frameworks',
    description: 'Wire the offline-first sync engine into Expo or React Native, from the SQLite driver to session persistence and attachments',
  },
  {
    slug: 'native-clients',
    file: 'docs/getting-started/native-clients.md',
    title: 'Swift and Kotlin',
    group: 'Getting started',
    subgroup: 'Frameworks',
    description: 'Build the in-repository UniFFI bindings and understand their current Alpha distribution limits',
  },
  {
    slug: 'vite',
    file: 'docs/getting-started/vite.md',
    title: 'Vite',
    group: 'Getting started',
    subgroup: 'Frameworks',
    description: 'Wire the browser worker driver and OPFS file store into a Vite-based React or Vue app with Supabase',
  },
  {
    slug: 'vanilla-js',
    file: 'docs/getting-started/vanilla-js.md',
    title: 'Vanilla JavaScript',
    group: 'Getting started',
    subgroup: 'Frameworks',
    description: 'Wire the core client into vanilla JavaScript or any UI without a dedicated Kizuna binding',
  },

  // MARK: - Sync
  {
    slug: 'offline-writes',
    file: 'docs/sync/offline-writes.md',
    title: 'Offline writes',
    group: 'Sync',
    subgroup: 'Guides',
    description: 'Durable queues, verdicts, sync state in your UI, patterns and limits',
  },
  {
    slug: 'sync-rules-and-buckets',
    file: 'docs/sync/sync-rules-and-buckets.md',
    title: 'Sync rules & buckets',
    group: 'Sync',
    subgroup: 'Guides',
    description: 'RLS as security, buckets as selection, the adoption ladder',
  },
  {
    slug: 'validate-writes',
    file: 'docs/sync/validate-writes.md',
    title: 'Validate writes',
    group: 'Sync',
    subgroup: 'Guides',
    description: 'Enforce your rules in Postgres with RLS, preconditions, constraints, and triggers, and surface every rejection in the app',
  },
  {
    slug: 'collaborative-fields',
    file: 'docs/sync/collaborative-fields.md',
    title: 'Collaborative fields',
    group: 'Sync',
    subgroup: 'Guides',
    description: 'Independent columns, increment and array transforms, the conflict journal, and client-side text merge',
  },
  {
    slug: 'conflict-resolution',
    file: 'docs/sync/conflict-resolution.md',
    title: 'Conflict resolution',
    group: 'Sync',
    subgroup: 'Concepts',
    description: 'How concurrent writes are detected, ordered, and resolved',
  },
  {
    slug: 'server-side-validation',
    file: 'docs/sync/server-side-validation.md',
    title: 'Server-side validation',
    group: 'Sync',
    subgroup: 'Concepts',
    description: 'Where every write is validated, which guards answer with a clean verdict, and how a rejection reaches your UI',
  },
  {
    slug: 'consistency-model',
    file: 'docs/sync/consistency-model.md',
    title: 'Consistency model',
    group: 'Sync',
    subgroup: 'Concepts',
    description: 'The guarantees and their limits',
  },
  {
    slug: 'fencing-and-horizons',
    file: 'docs/sync/fencing-and-horizons.md',
    title: 'Fencing and horizons',
    group: 'Sync',
    subgroup: 'Concepts',
    description: 'Why a naive cursor skips committed changes, and the xid8 horizon that fixes it',
  },
  {
    slug: 'protocol-overview',
    file: 'docs/sync/protocol-overview.md',
    title: 'Protocol overview',
    group: 'Sync',
    subgroup: 'Concepts',
    description: 'The wire protocol, message types, and session lifecycle',
  },

  // MARK: - Attachments
  {
    slug: 'media-and-attachments',
    file: 'docs/attachments/media-and-attachments.md',
    title: 'Media attachments',
    group: 'Attachments',
    description: 'Attachment sync, lazy downloads, integrity, platform truths',
  },

  // MARK: - CLI & provisioning
  {
    slug: 'cli',
    file: 'docs/cli/cli.md',
    title: 'CLI',
    group: 'CLI & provisioning',
    description: 'init · sync · status · doctor · lint · upgrade · deprovision · mock',
  },
  {
    slug: 'configuration',
    file: 'docs/cli/configuration.md',
    title: 'Configuration',
    group: 'CLI & provisioning',
    description: 'kizunasync._config and kizunasync._settings: every column, every default',
  },
  {
    slug: 'install',
    file: 'docs/cli/install.md',
    title: 'Install',
    group: 'CLI & provisioning',
    description: 'Preview the plan and provision the SQL pack locally or through the Management API',
  },
  {
    slug: 'whats-installed',
    file: 'docs/cli/whats-installed.md',
    title: 'What Kizuna installs',
    group: 'CLI & provisioning',
    description: 'The Kizuna schema, internal tables, five public RPCs, per-table triggers, provision ledger, and grants created by the current pack',
  },
  {
    slug: 'manage-synced-tables',
    file: 'docs/cli/manage-synced-tables.md',
    title: 'Manage synced tables',
    group: 'CLI & provisioning',
    description: 'Use kizunasync sync to edit the synchronized table set, generate one delta migration, and optionally apply it',
  },
  {
    slug: 'upgrading',
    file: 'docs/cli/upgrading.md',
    title: 'Upgrade',
    group: 'CLI & provisioning',
    description: 'Reconcile an installed project file ledger with the current pack and refuse drift or breaking pending files',
  },
  {
    slug: 'removing',
    file: 'docs/cli/removing.md',
    title: 'Remove',
    group: 'CLI & provisioning',
    description: 'Preview and remove understood ledgered Kizuna objects while preserving application tables and data',
  },
  {
    slug: 'local-supabase',
    file: 'docs/cli/local-supabase.md',
    title: 'Local Supabase',
    group: 'CLI & provisioning',
    description: 'Start, inspect, migrate, stop, and deliberately reset the repository local Supabase development stack',
  },

  // MARK: - Testing & operations
  {
    slug: 'test-offline-behavior',
    file: 'docs/operations/test-offline-behavior.md',
    title: 'Test offline behavior',
    group: 'Testing & operations',
    description: 'Fault injection, the headless matrix, CI integration',
  },
  {
    slug: 'ci-cd',
    file: 'docs/operations/ci-cd.md',
    title: 'CI and CD',
    group: 'Testing & operations',
    description: 'The quality gate, Supabase database tests, and conformance corpus harness that run on every push and pull request',
  },
  {
    slug: 'troubleshooting',
    file: 'docs/operations/troubleshooting.md',
    title: 'Troubleshooting',
    group: 'Testing & operations',
    description: 'Diagnose the OPFS lock, bucket, attachment, and RLS errors you hit most often, with the exact fix for each',
  },

  // MARK: - Reference
  {
    slug: 'query-operators',
    file: 'docs/reference/query-operators.md',
    title: 'Supported query operators',
    group: 'Reference',
    description: 'Every postgrest-js method and option, with its status in the JavaScript, Swift, and Kotlin app clients',
  },
  {
    slug: 'sql-pack',
    file: 'docs/reference/sql-pack.md',
    title: 'SQL pack',
    group: 'Reference',
    description: 'The tables, RPCs, sequences, and maintenance functions the 0001_kizuna_init.sql migration provisions into your project',
  },
  {
    slug: 'protocol',
    file: 'docs/reference/protocol.md',
    title: 'Protocol reference',
    group: 'Reference',
    description: 'Wire shapes, verdict kinds, the cursor codec, and fencing rules, cross-referenced to the conformance corpus',
  },
  {
    slug: 'status-taxonomy',
    file: 'docs/reference/status-taxonomy.md',
    title: 'Status taxonomy',
    group: 'Reference',
    description: 'Maturity labels, decision and corpus statuses, sync phases, attachment states, rejection kinds, and wire status values',
  },
  {
    slug: 'drivers-and-tck',
    file: 'docs/reference/drivers-and-tck.md',
    title: 'Drivers and the TCK',
    group: 'Reference',
    description: 'The platform-port boundary, protocol-corpus evidence, and the limits of current driver conformance',
  },

  // MARK: - Resources
  {
    slug: 'architecture-overview',
    file: 'docs/resources/architecture.md',
    title: 'Architecture',
    group: 'Resources',
    description: 'The device engine, the SQL pack, and what deliberately does not exist',
  },
  {
    slug: 'design-tradeoffs',
    file: 'docs/resources/design-tradeoffs.md',
    title: 'Design trade-offs',
    group: 'Resources',
    description: 'What Kizuna deliberately does not do, why, what it does instead, and how each trade-off is enforced',
  },
  {
    slug: 'protocol-decisions',
    file: 'docs/resources/protocol-decisions.md',
    title: 'Protocol decisions',
    group: 'Resources',
    description: 'The open-decision model, what is implemented, and what remains planned',
  },
  {
    slug: 'repository-layout',
    file: 'docs/resources/repository-layout.md',
    title: 'Repository layout',
    group: 'Resources',
    description: 'Rust kernel, UniFFI and N-API bridges, JS/Swift/Kotlin app clients, CLI, and examples',
  },
  {
    slug: 'native-packaging',
    file: 'docs/resources/native-packaging.md',
    title: 'Native packaging',
    group: 'Resources',
    description: 'Regenerate UniFFI bindings and build the XCFramework, AAR, and React Native module from a checkout',
  },
  {
    slug: 'glossary',
    file: 'docs/resources/glossary.md',
    title: 'Glossary',
    group: 'Resources',
    description: 'Definitions for terms used throughout the Kizuna documentation',
  },
  {
    slug: 'roadmap',
    file: 'docs/resources/roadmap.md',
    title: 'Roadmap',
    group: 'Resources',
    description: 'Implemented Alpha surfaces, remaining release gaps, and later work without presenting plans as shipped features',
  },
  {
    slug: 'contribute',
    file: 'docs/resources/contribute.md',
    title: 'Contribute',
    group: 'Resources',
    description: 'How to build, test, document, and license a change to Kizuna',
  },
  {
    slug: 'governance',
    file: 'GOVERNANCE.md',
    title: 'Governance',
    group: 'Resources',
    description: 'Apache-2.0, PolyForm Shield on the SQL pack, never-paywall drivers, RFC process, honesty rules',
  },
]

export const DOC_GROUPS = ['Getting started', 'Sync', 'Attachments', 'CLI & provisioning', 'Testing & operations', 'Reference', 'Resources'] as const

/** Reader nav surfaces (sidebar, mobile drawer, prev/next, docs hub). */
export function docsForNav(entries: readonly IDocEntry[] = DOCS): IDocEntry[] {
  return entries.filter((doc) => doc.navHidden !== true)
}

/** Resolves a relative markdown path from a repo-relative source file (posix). */
function resolveRepoPath(fromFile: string, relative: string): string {
  const stack = fromFile.split('/').slice(0, -1)

  for (const segment of relative.split('/')) {
    if (segment.length === 0 || segment === '.') {
      continue
    }
    if (segment === '..') {
      stack.pop()
    } else {
      stack.push(segment)
    }
  }
  return stack.join('/')
}

/** `sourceFile` is known: resolve `path` relative to it before matching a doc or a reference page. */
function resolveDocHrefFromSource(sourceFile: string, path: string, fragment: string): string {
  const target = resolveRepoPath(sourceFile, path)
  const byExact = DOCS.find((doc) => doc.file === target)

  if (byExact !== undefined) {
    return `/docs/${byExact.slug}${fragment}`
  }
  const refRoute = referenceRouteForFile(target)

  if (refRoute !== undefined) {
    return `${refRoute}${fragment}`
  }
  return `${GITHUB_URL}/blob/main/${target}${fragment}`
}

/** No `sourceFile`: strip leading `./`/`../` and match by suffix against every doc and reference page. */
function resolveDocHrefBySuffix(path: string, fragment: string): string {
  const cleaned = path.replace(/^(\.\/)+/, '').replace(/^(\.\.\/)+/, '')
  const bySuffix = DOCS.find(
    (doc) =>
      doc.file === cleaned ||
      doc.file === `docs/${cleaned}` ||
      doc.file.endsWith(`/${cleaned}`),
  )

  if (bySuffix !== undefined) {
    return `/docs/${bySuffix.slug}${fragment}`
  }
  const refRoute =
    referenceRouteForFile(cleaned) ??
    referenceRouteForFile(`docs/${cleaned}`)

  if (refRoute !== undefined) {
    return `${refRoute}${fragment}`
  }
  return `${GITHUB_URL}/blob/main/${cleaned}${fragment}`
}

/** Rewrites repo-relative markdown links to in-site or GitHub URLs. */
export function resolveDocHref(href: string, sourceFile?: string): string {
  if (/^(https?:|mailto:|#)/.test(href)) {
    return href
  }
  const [path = '', anchor = ''] = href.split('#')
  const fragment = anchor.length > 0 ? `#${anchor}` : ''

  return sourceFile !== undefined
    ? resolveDocHrefFromSource(sourceFile, path, fragment)
    : resolveDocHrefBySuffix(path, fragment)
}
