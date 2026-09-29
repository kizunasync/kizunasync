import { GlobalRegistrator } from '@happy-dom/global-registrator'

/**
 * Register a DOM (window/document/…) so @testing-library/react can mount hooks
 * under `bun test`. Loaded via bunfig.toml [test] preload, and imported from
 * the hook test files so a repo-root `bun test` still has a document.
 */
if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register()
}
