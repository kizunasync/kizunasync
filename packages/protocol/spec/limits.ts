/** Server default pull page limit. Owner: `kizunasync._pull_impl` `default 500`. */
export const DEFAULT_PAGE_LIMIT = 500

/** Server default pull scan cap: the candidates one page examines at most. Owner: `kizunasync._settings.max_pull_scan` `default 5000`. */
export const DEFAULT_MAX_PULL_SCAN = 5000

/** Bucket entries one pull may name. Owner: `kizunasync._pull_impl` `v_max_buckets`. */
export const MAX_PULL_BUCKETS = 64
