import type { IReferenceLibrary } from '../reference-registry'
import { SWIFT } from './swift'

// MARK: - Kotlin client reference tree

export const KOTLIN: IReferenceLibrary = {
  id: 'kotlin',
  title: 'Kotlin',
  packageName: 'com.kizunasync:kizunasync',
  description:
    'KizunaSyncClient over UniFFI for Android apps: typed config, optimistic writes, local queries, sync, rejections, events, and attachments',
  codeLangs: ['kotlin'],
  versionSource: { kind: 'cargo-workspace', path: 'Cargo.toml' },
  supabaseReferenceUrl: 'https://supabase.com/docs/reference/kotlin/introduction',
  pages: SWIFT.pages,
}
