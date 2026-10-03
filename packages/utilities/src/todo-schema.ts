/**
 * The todos table schema shared by the React, Vue, and Expo examples: the
 * table and bucket names, the row shape defineConfig validates against, and
 * the bucketless config itself (attachments on image_path). Each example's
 * kizunasync.ts still owns the driver, connectivity gate, wakeup, and
 * createSupabaseKizunaSync call: only the schema is common between them.
 */

import { attachment, defineConfig } from '@kizunasync/core'

// MARK: - Table and bucket names

export const TODOS_TABLE = 'todos'
export const IMAGE_BUCKET = 'todos'

/**
 * The soft-delete marker column. It is a normal synced column: null means live,
 * a timestamp means archived, and the row is never tombstoned, so it keeps
 * merging under column-LWW. The config does not declare `softDelete`, which
 * keeps the hard-delete path available.
 */
export const ARCHIVED_COLUMN = 'archived_at'

// MARK: - Row shape

/**
 * The examples have no generated supabase types; this minimal shape is what
 * defineConfig validates against: a typo'd table/column is a compile error.
 */
export type TTodoRow = {
  id: string
  user_id: string
  title: string
  done: boolean
  image_path: string | null
  created_at: string
  archived_at: string | null
}

export type TTodoDatabase = {
  public: { Tables: { todos: { Row: TTodoRow } } }
}

// MARK: - Config

/**
 * A bucketless table requests every RLS-permitted row and its deletes.
 * `0002_example.sql` provisions todos without a bucket column and shows every
 * visitor every row of the shared board. The empty parameter map stays bounded
 * by server RLS. A table provisioned WITH a bucket column refuses an unscoped
 * pull with `KZL01`.
 */
export const todosConfig = defineConfig<TTodoDatabase>({
  tables: {
    todos: {
      sync: 'read-write',
      /**
       * The image column is an attachment: the row carries a reference (the
       * Storage object key), the bytes travel via the IFileStore + ITransfer
       * ports. No client-only column: image_path is a normal synced column.
       */
      attachments: { image_path: attachment(IMAGE_BUCKET, { ownerColumn: 'user_id' }) },
    },
  },
})
