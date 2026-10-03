import type { IReferenceLibrary } from '../reference-registry'

// MARK: - Vue client reference tree

export const VUE: IReferenceLibrary = {
  id: 'vue',
  title: 'Vue',
  packageName: 'kizunasync/vue',
  description:
    'createKizunaSyncPlugin, provideKizunaSync, and the useKizunaSync, useQuery, useMutation, useSyncStatus, useAttachment, useRejections, and useOverwrites composables',
  codeLangs: ['ts', 'vue'],
  versionSource: { kind: 'package-json', path: 'packages/kizunasync/package.json' },
  supabaseReferenceUrl: 'https://supabase.com/docs/reference/javascript/introduction',
  pages: [
    { slug: 'introduction', title: 'Introduction', kind: 'introduction' },
    { slug: 'installing', title: 'Installing', kind: 'installing' },
    { slug: 'initializing', title: 'Initializing', kind: 'initializing' },
    { slug: 'use-kizunasync', title: 'useKizunaSync', kind: 'method', section: 'Composables' },
    { slug: 'use-query', title: 'useQuery', kind: 'method', section: 'Composables' },
    { slug: 'use-mutation', title: 'useMutation', kind: 'method', section: 'Composables' },
    { slug: 'use-sync-status', title: 'useSyncStatus', kind: 'method', section: 'Composables' },
    { slug: 'use-attachment', title: 'useAttachment', kind: 'method', section: 'Composables' },
    { slug: 'use-rejections', title: 'useRejections', kind: 'method', section: 'Composables' },
    { slug: 'use-overwrites', title: 'useOverwrites', kind: 'method', section: 'Composables' },
  ],
}
