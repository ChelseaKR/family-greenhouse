/**
 * Offline sync engine.
 *
 * When the browser comes back online, this module replays queued mutations
 * against the API. Each mutation is retried with exponential backoff (max 3
 * attempts). A successful replay marks the mutation completed and invalidates
 * the relevant TanStack Query caches. A conflict (server says `changed: false`)
 * is treated as successful — someone else already acted.
 */

import { type QueryClient } from '@tanstack/react-query';
import { taskService, type SnoozeReason } from '../services/taskService';
import {
  type QueuedMutation,
  getPendingMutations,
  markCompleted,
  markFailed,
} from './offlineQueue';
import { connectionStoreFor } from './connectionStatus';

const MAX_REPLAY_ATTEMPTS = 3;
const BASE_DELAY_MS = 1_000;

/** Replay all pending mutations. Returns the count of successfully replayed mutations. */
export async function replayPendingMutations(queryClient: QueryClient): Promise<number> {
  const pending = await getPendingMutations();
  if (pending.length === 0) return 0;

  // Sort by queuedAt so we replay in FIFO order.
  pending.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));

  let replayed = 0;
  for (const mutation of pending) {
    if (mutation.attempts >= MAX_REPLAY_ATTEMPTS) {
      // Give up after max attempts — leave in queue for manual review.
      continue;
    }

    try {
      await executeMutation(mutation);
      await markCompleted(mutation.id);
      invalidateQueries(queryClient, mutation);
      replayed += 1;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await markFailed(mutation.id, msg);

      // Exponential backoff before next attempt.
      const delay = BASE_DELAY_MS * Math.pow(2, mutation.attempts);
      await sleep(delay);
    }
  }

  return replayed;
}

/** Execute a single queued mutation against the API. */
async function executeMutation(mutation: QueuedMutation): Promise<void> {
  const { type, taskId, args } = mutation;

  switch (type) {
    case 'complete':
      await taskService.completeTask(
        taskId,
        args as { expectedNextDue?: string; confirmDuplicate?: boolean }
      );
      break;
    case 'snooze':
      await taskService.snoozeTask(taskId, (args.days as number) || 1, {
        reason: args.reason as SnoozeReason,
        expectedNextDue: args.expectedNextDue as string,
      });
      break;
    case 'claim':
      await taskService.claimTask(taskId);
      break;
    case 'unclaim':
      await taskService.unclaimTask(taskId);
      break;
    default:
      throw new Error(`Unknown mutation type: ${type}`);
  }
}

/** Invalidate the relevant query caches after a successful replay. */
function invalidateQueries(queryClient: QueryClient, mutation: QueuedMutation): void {
  queryClient.invalidateQueries({ queryKey: ['tasks', mutation.householdId] });
  queryClient.invalidateQueries({ queryKey: ['plants', mutation.householdId] });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Set up automatic replay when connectivity returns.
 * Call once at app startup.
 */
export function setupOfflineSync(queryClient: QueryClient): () => void {
  // Replay on online transition.
  const unsubscribe = connectionStoreFor(queryClient).subscribe(() => {
    const state = connectionStoreFor(queryClient).getState();
    if (state.online) {
      // Small delay to let the network stabilize.
      setTimeout(() => replayPendingMutations(queryClient), 1_000);
    }
  });

  // Also replay immediately on mount if there are pending mutations
  // (handles the case where the app loads while already online).
  replayPendingMutations(queryClient).catch(() => {
    // Non-fatal — mutations stay in queue for next online event.
  });

  return unsubscribe;
}
