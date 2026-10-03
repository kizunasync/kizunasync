/**
 * A store locator over a fresh temp database file, for headless tests against the
 * real engine. The client conformance harness lives in `@kizunasync/core/conformance`,
 * a repository checkout only subpath.
 */

// MARK: - @kizunasync/core/testing

export { createTempDatabase, type ITempDatabase } from './temp-database'
