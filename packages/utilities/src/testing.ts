/**
 * Shared fixtures for the example round-trip tests (React, Vue, and Expo).
 *
 * The suite runs on the Rust engine through the N-API addon, so build it first
 * with `bun run cargo:napi` from the repository root. A missing addon fails the
 * suite loudly, because `createKizunaSync` has no other engine to run.
 *
 * Exported through the `@kizunasync/utilities/testing` subpath, never the package
 * root, so a production bundle never pulls it in.
 */

import { defineConfig, type TKizunaSyncConfig } from 'kizunasync'

/**
 * The typed authoring surface that defineConfig validates against: a minimal
 * todos row, not the examples' full TTodoRow from todo-schema.ts. The config
 * below references no column, so the exact Row shape does not leak into the
 * TKizunaSyncConfig this returns.
 */
type TTodoDatabase = {
  public: {
    Tables: {
      todos: {
        Row: { id: string; user_id: string; title: string; done: boolean; image_path: string | null }
      }
    }
  }
}

/** Factory for a deterministic, incrementing UUID generator (one per device/context). */
export const makeUuid = (): (() => string) => {
  let n = 0

  return () => {
    n += 1

    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  }
}

/**
 * Minimal config matching kizunasync.ts: no client bucket, so the remote is asked for
 * its complete RLS-permitted set. The attachment column kizunasync.ts declares is left
 * out: bytes need the file store and transfer ports, which this engine-level
 * round trip does not exercise.
 */
export function makeTodosConfig(): TKizunaSyncConfig {
  return defineConfig<TTodoDatabase>({
    tables: {
      todos: { sync: 'read-write' },
    },
  })
}
