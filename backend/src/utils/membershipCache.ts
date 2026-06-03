/**
 * Per-warm-container cache of household memberships, keyed by
 * `<userId>#<householdId>`. Lets `authMiddleware` skip the DDB GetItem on
 * repeat requests from the same client without crossing the trust
 * boundary — we still validate first time we see the pairing.
 *
 * Kept in its own module so services can invalidate entries when
 * memberships change (role flip, member removed) without importing
 * middleware (avoids a service → middleware cross-layer dep).
 */

const TTL_MS = 60_000;

interface Entry {
  role: 'admin' | 'member';
  expiresAt: number;
}

const cache = new Map<string, Entry>();

function key(userId: string, householdId: string): string {
  return `${userId}#${householdId}`;
}

export function getCachedMembership(
  userId: string,
  householdId: string
): 'admin' | 'member' | undefined {
  const entry = cache.get(key(userId, householdId));
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key(userId, householdId));
    return undefined;
  }
  return entry.role;
}

export function setCachedMembership(
  userId: string,
  householdId: string,
  role: 'admin' | 'member'
): void {
  cache.set(key(userId, householdId), { role, expiresAt: Date.now() + TTL_MS });
}

/**
 * Drop the cached membership for (userId, householdId). Called from
 * service-layer mutations so the next request re-reads from DDB and sees
 * the new role — or, on remove, the absence of membership.
 *
 * Omit `householdId` to drop every cached entry for the user (e.g. on
 * account deletion). Cheap; the cache lives in a single Map.
 */
export function invalidateMembership(userId: string, householdId?: string): void {
  if (householdId) {
    cache.delete(key(userId, householdId));
    return;
  }
  const prefix = `${userId}#`;
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

/** Test hook — drops every cached entry. */
export function __resetMembershipCacheForTests(): void {
  cache.clear();
}
