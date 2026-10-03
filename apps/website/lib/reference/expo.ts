import type { IReferenceLibrary } from '../reference-registry'

// MARK: - Expo / React Native client reference tree

export const EXPO: IReferenceLibrary = {
  id: 'expo',
  title: 'Expo',
  packageName: 'kizunasync/expo',
  description:
    'SQLite drivers, connectivity, file store, and native download helpers for Expo and React Native',
  codeLangs: ['ts', 'tsx'],
  versionSource: { kind: 'package-json', path: 'packages/kizunasync/package.json' },
  supabaseReferenceUrl: 'https://supabase.com/docs/reference/javascript/introduction',
  pages: [
    { slug: 'introduction', title: 'Introduction', kind: 'introduction' },
    { slug: 'installing', title: 'Installing', kind: 'installing' },
    { slug: 'initializing', title: 'Initializing', kind: 'initializing' },
    { slug: 'open-expo-driver', title: 'Open the SQLite driver', kind: 'method', section: 'Drivers' },
    { slug: 'open-op-sqlite-driver', title: 'op-sqlite driver', kind: 'method', section: 'Drivers' },
    { slug: 'verify-op-sqlite-driver', title: 'Verify op-sqlite', kind: 'method', section: 'Drivers' },
    { slug: 'create-expo-connectivity', title: 'Connectivity', kind: 'method', section: 'Drivers' },
    { slug: 'create-expo-foreground', title: 'Foreground', kind: 'method', section: 'Drivers' },
    { slug: 'open-expo-file-store', title: 'File store', kind: 'method', section: 'Files' },
    { slug: 'create-expo-supabase-download', title: 'Native download', kind: 'method', section: 'Files' },
    { slug: 'rust-engine', title: 'Rust engine', kind: 'guide', section: 'Engine' },
  ],
}
