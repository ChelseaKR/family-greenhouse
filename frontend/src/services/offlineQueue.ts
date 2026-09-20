/**
 * Offline mutation queue backed by IndexedDB.
 *
 * When the browser is offline, task mutations (complete, snooze, claim, unclaim)
 * are serialized into IndexedDB and replayed when connectivity returns. Each
 * entry carries enough context to reconstruct the API call and to detect
 * conflicts on replay (the server's `changed: false` response means someone
 * else acted first).
 */

import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'family-greenhouse-offline';
const DB_VERSION = 1;
const STORE_NAME = 'mutations';

export interface QueuedMutation {
  /** UUID generated at enqueue time. */
  id: string;
  /** ISO-8601 timestamp of when the mutation was queued. */
  queuedAt: string;
  /** The TanStack Query key prefix for cache invalidation on replay. */
  queryKey: readonly unknown[];
  /** Mutation type — maps to the taskService method to call. */
  type: 'complete' | 'snooze' | 'claim' | 'unclaim';
  /** The task ID being acted on. */
  taskId: string;
  /** The household ID (for query invalidation). */
  householdId: string;
  /** Serialized mutation arguments (excluding taskId, which is the path param). */
  args: Record<string, unknown>;
  /** Number of replay attempts (for backoff). */
  attempts: number;
  /** ISO-8601 or null — set after a successful replay. */
  completedAt: string | null;
  /** Error message from the last failed replay attempt. */
  lastError: string | null;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('by-type', 'type');
        store.createIndex('by-task', 'taskId');
        store.createIndex('by-status', 'completedAt');
      },
    });
  }
  return dbPromise;
}

/** Enqueue a mutation for later replay. Returns the queued entry. */
export async function enqueueMutation(
  entry: Omit<QueuedMutation, 'id' | 'queuedAt' | 'attempts' | 'completedAt' | 'lastError'>
): Promise<QueuedMutation> {
  const db = await getDB();
  const mutation: QueuedMutation = {
    ...entry,
    id: crypto.randomUUID(),
    queuedAt: new Date().toISOString(),
    attempts: 0,
    completedAt: null,
    lastError: null,
  };
  await db.put(STORE_NAME, mutation);
  return mutation;
}

/** Get all pending (not yet completed) mutations. */
export async function getPendingMutations(): Promise<QueuedMutation[]> {
  const db = await getDB();
  const all = await db.getAll(STORE_NAME);
  return all.filter((m) => m.completedAt === null);
}

/** Get all mutations (for display in settings). */
export async function getAllMutations(): Promise<QueuedMutation[]> {
  const db = await getDB();
  return db.getAll(STORE_NAME);
}

/** Mark a mutation as completed. */
export async function markCompleted(id: string): Promise<void> {
  const db = await getDB();
  const entry = await db.get(STORE_NAME, id);
  if (entry) {
    entry.completedAt = new Date().toISOString();
    await db.put(STORE_NAME, entry);
  }
}

/** Mark a mutation as failed (update attempts and lastError). */
export async function markFailed(id: string, error: string): Promise<void> {
  const db = await getDB();
  const entry = await db.get(STORE_NAME, id);
  if (entry) {
    entry.attempts += 1;
    entry.lastError = error;
    await db.put(STORE_NAME, entry);
  }
}

/** Remove a mutation from the queue. */
export async function removeMutation(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_NAME, id);
}

/** Clear all completed mutations older than the given age (default 7 days). */
export async function pruneCompleted(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  const db = await getDB();
  const all = await db.getAll(STORE_NAME);
  const cutoff = Date.now() - maxAgeMs;
  let pruned = 0;
  for (const entry of all) {
    if (entry.completedAt && new Date(entry.completedAt).getTime() < cutoff) {
      await db.delete(STORE_NAME, entry.id);
      pruned += 1;
    }
  }
  return pruned;
}

/** Count of pending mutations (for the badge indicator). */
export async function pendingCount(): Promise<number> {
  const db = await getDB();
  const all = await db.getAll(STORE_NAME);
  return all.filter((m) => m.completedAt === null).length;
}
