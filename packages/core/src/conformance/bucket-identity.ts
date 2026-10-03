// MARK: - Identity-bucket comparison

/**
 * Which pull requests belong to THIS client: a recorded request whose buckets are
 * not the configured identity set is a cross-bucket probe (tombstones/003) that
 * the protocol executor and live SQL own, so both client adapters skip it.
 */

/** One bucket's order-independent key: the table plus its params, sorted. */
function bucketKey(bucket: unknown): string {
  if (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket)) {
    return ''
  }
  const record = bucket as { params?: unknown; table?: unknown }
  const table = typeof record.table === 'string' ? record.table : ''
  const params =
    typeof record.params === 'object' && record.params !== null && !Array.isArray(record.params)
      ? (record.params as Record<string, unknown>)
      : {}
  const normalized = Object.fromEntries(Object.keys(params).sort().map((key) => [key, params[key]]))

  return `${table}:${JSON.stringify(normalized)}`
}

/** Whether two bucket lists are the same SET: pull buckets carry no emit order. */
export function sameBucketSet(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false
  }
  const a = left.map(bucketKey).sort()
  const b = right.map(bucketKey).sort()

  return a.every((key, index) => key === b[index])
}
