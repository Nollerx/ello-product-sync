// In-memory, version-keyed, single-flight cache for expensive widget reads.
//
// Cloud Run runs many instances, so this cache is PER INSTANCE. Correctness comes
// from the `version` argument, not from any cross-instance coordination: each entry
// records the version it was built for, and a request whose version differs rebuilds.
// Bumping the source version (e.g. vto_stores.config_version — moved by the products
// webhook, a settings save, or the merchant's "Refresh widget" button) therefore
// invalidates every instance independently on its next request.
//
// `maxStaleMs` is a safety net: even if the version somehow never changes (a dropped
// Shopify webhook), the entry is rebuilt after that long so the widget can't be
// permanently stale. Concurrent misses for the same key+version share ONE build
// (single-flight), so a traffic spike can't fan out into N identical Shopify crawls.

type CacheEntry<T> = { version: string; value: T; builtAt: number };

export function createVersionedCache<T>(maxStaleMs: number) {
  const cache = new Map<string, CacheEntry<T>>();
  const inflight = new Map<string, Promise<T>>();

  return async function getOrBuild(
    key: string,
    version: string,
    build: () => Promise<T>,
  ): Promise<T> {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.version === version && now - hit.builtAt < maxStaleMs) {
      return hit.value;
    }

    // Coalesce concurrent misses for the same key+version onto one build.
    const flightKey = `${key}@${version}`;
    const existing = inflight.get(flightKey);
    if (existing) return existing;

    const p = (async () => {
      try {
        const value = await build();
        cache.set(key, { version, value, builtAt: Date.now() });
        return value;
      } catch (err) {
        // On build failure, serve the last good value if we have one rather than
        // surfacing an error to the shopper; only throw if we've never built.
        const stale = cache.get(key);
        if (stale) return stale.value;
        throw err;
      } finally {
        inflight.delete(flightKey);
      }
    })();

    inflight.set(flightKey, p);
    return p;
  };
}
