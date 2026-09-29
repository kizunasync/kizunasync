import type { IReferenceLibrary } from '../reference-registry'

// MARK: - React client reference tree

export const REACT: IReferenceLibrary = {
  id: 'react',
  title: 'React',
  packageName: '@kizunasync/react',
  description:
    'KizunaSyncProvider and the useKizunaSync, useQuery, useMutation, useSyncStatus, useAttachment, useRejections, and useOverwrites hooks',
  codeLangs: ['tsx', 'ts'],
  versionSource: { kind: 'package-json', path: 'packages/react/package.json' },
  supabaseReferenceUrl: 'https://supabase.com/docs/reference/javascript/introduction',
  pages: [
    { slug: 'introduction', title: 'Introduction', kind: 'introduction' },
    { slug: 'installing', title: 'Installing', kind: 'installing' },
    { slug: 'initializing', title: 'Initializing', kind: 'initializing' },
    { slug: 'use-kizunasync', title: 'useKizunaSync', kind: 'method', section: 'Hooks' },
    { slug: 'use-query', title: 'useQuery', kind: 'method', section: 'Hooks' },
    { slug: 'use-mutation', title: 'useMutation', kind: 'method', section: 'Hooks' },
    { slug: 'use-sync-status', title: 'useSyncStatus', kind: 'method', section: 'Hooks' },
    { slug: 'use-attachment', title: 'useAttachment', kind: 'method', section: 'Hooks' },
    { slug: 'use-rejections', title: 'useRejections', kind: 'method', section: 'Hooks' },
    { slug: 'use-overwrites', title: 'useOverwrites', kind: 'method', section: 'Hooks' },
  ],
}
