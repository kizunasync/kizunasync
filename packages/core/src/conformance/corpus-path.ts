// MARK: - Corpus root resolution

/**
 * The golden corpus lives in the `@kizunasync/protocol` workspace. Read in place:
 * no transcript bytes copied, no corpus artifacts created
 * (@../../../../CONVENTIONS.md). This module resolves the absolute
 * `packages/protocol/` root so the protocol harness loader
 * (`readCorpusFile(root, rel)`) can hit the live corpus directly.
 *
 * `@kizunasync/protocol` has no package `exports` map. The root comes from the
 * workspace package itself (cross-workspace by package name, not a relative
 * `../../` climb; @../../../../CONVENTIONS.md) with a filesystem-walk fallback
 * for the window before `bun install` materializes the workspace symlink
 * (`packages/protocol/tsconfig.json` documents that gap).
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// MARK: - Marker

/**
 * The corpus manifest is the unambiguous root marker: the packages/protocol/ dir is the
 * only directory in the repo that contains cases/manifest.json.
 */
const MANIFEST_REL = join('cases', 'manifest.json')

const hasCorpus = (dir: string): boolean => existsSync(join(dir, MANIFEST_REL))

// MARK: - Package-name resolution

/**
 * import.meta.resolve returns the URL of @kizunasync/protocol's package.json once
 * the workspace is linked; its directory is the corpus root. Wrapped because
 * resolution throws when the symlink is not yet materialized.
 */
const resolveViaPackage = (): string | null => {
  try {
    const url = import.meta.resolve('@kizunasync/protocol/package.json')
    const root = dirname(fileURLToPath(url))

    return hasCorpus(root) ? root : null
  } catch {
    return null
  }
}

// MARK: - Filesystem-walk fallback

/**
 * Climb from this module toward the filesystem root; the workspace layout puts
 * packages/protocol/ as a sibling of packages/, so the first ancestor that contains a
 * packages/protocol/cases/manifest.json is the monorepo root's protocol dir.
 */
const resolveViaWalk = (): string | null => {
  let dir = dirname(fileURLToPath(import.meta.url))

  for (;;) {
    const candidate = join(dir, 'protocol')

    if (hasCorpus(candidate)) {
      return candidate
    }
    const parent = dirname(dir)

    if (parent === dir) {
      return null
    }
    dir = parent
  }
}

// MARK: - Public API

/**
 * Absolute path to the `@kizunasync/protocol` corpus root (`packages/protocol/`),
 * suitable for `readCorpusFile(root, 'transcripts/…')`. Throws if the corpus
 * cannot be located: a missing corpus is a setup failure, not a green test
 * (@../../../../CONVENTIONS.md).
 */
export const resolveCorpusRoot = (): string => {
  const root = resolveViaPackage() ?? resolveViaWalk()

  if (root === null) {
    throw new Error(
      'resolveCorpusRoot: could not locate the @kizunasync/protocol corpus ' +
        '(no packages/protocol/cases/manifest.json via package resolution or filesystem walk): ' +
        'run `bun install` at the repo root to link the workspace'
    )
  }
  return root
}
