// MARK: - In-memory rate limiting

/**
 * Per-instance only: this Map has no shared backing store (the website has no
 * Supabase/Redis dependency), so counters reset on every cold start and are NOT
 * shared across server replicas or serverless instances. Acceptable for a
 * low-traffic OSS feedback form; a multi-instance deploy under real abuse would
 * need a shared store instead.
 */
interface Bucket {
  timestamps: number[]
  windowMs: number
}

const hits = new Map<string, Bucket>()

/**
 * Upper bound on distinct tracked keys. Without a trusted reverse proxy,
 * `x-real-ip` is caller-controlled (`WEBSITE_TRUST_PROXY_HEADERS`, see
 * `lib/client-ip.ts`), so an attacker cycling through spoofed IPs could
 * otherwise grow this map without bound.
 */
export const MAX_TRACKED_KEYS = 5_000

/**
 * Drops every key whose own window has fully elapsed, across the whole map.
 * A key an attacker touches once and abandons would otherwise linger forever,
 * since nothing else ever revisits it.
 */
function evictExpired(now: number): void {
  for (const [trackedKey, bucket] of hits) {
    const recent = bucket.timestamps.filter((timestamp) => timestamp > now - bucket.windowMs)

    if (recent.length === 0) {
      hits.delete(trackedKey)
    } else if (recent.length !== bucket.timestamps.length) {
      bucket.timestamps = recent
    }
  }
}

/**
 * Consumes one unit against an in-memory rate limit, returning true when the
 * caller is within `limit` for the current `windowMs` window.
 */
export async function consumeRateLimit(
  key: string,
  windowMs: number,
  limit: number,
): Promise<boolean> {
  const now = Date.now()

  evictExpired(now)

  const recent = (hits.get(key)?.timestamps ?? []).filter((timestamp) => timestamp > now - windowMs)

  if (recent.length >= limit) {
    hits.set(key, { timestamps: recent, windowMs })

    return false
  }
  recent.push(now)

  if (!hits.has(key) && hits.size >= MAX_TRACKED_KEYS) {
    const oldestKey = hits.keys().next().value

    if (oldestKey !== undefined) {
      hits.delete(oldestKey)
    }
  }
  hits.set(key, { timestamps: recent, windowMs })

  return true
}

/** Test-only: clears every counter so cases don't leak state across tests. */
export function resetRateLimitForTests(): void {
  hits.clear()
}

/** Test-only: the number of distinct keys currently tracked. */
export function rateLimitTrackedKeyCountForTests(): number {
  return hits.size
}
