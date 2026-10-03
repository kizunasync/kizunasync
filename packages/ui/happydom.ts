import { GlobalRegistrator } from '@happy-dom/global-registrator'

/**
 * Register a DOM (window/document/…) so @testing-library/react can mount
 * components under `bun test`. Loaded via bunfig.toml [test] preload, and
 * imported from the test files so a repo-root `bun test` still has a document.
 */
if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register()
}
