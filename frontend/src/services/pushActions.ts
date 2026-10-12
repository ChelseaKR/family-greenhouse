import type { QueryClient } from '@tanstack/react-query';
import { isNativeApp } from '@/lib/platform';
import { runPushAction, SNOOZE_DAYS } from './pushActionRunner';

/**
 * Acting on a reminder from the notification itself: Done, or Snooze until
 * tomorrow, without opening the task.
 *
 * A single-task reminder carries the task it is about (`task` on the push
 * payload: ids and the occurrence's due date, nothing else; see
 * `notifier.PushTaskRef`). The platform shows the two actions:
 *
 *   - iOS: the registered notification category
 *     (`ios/App/App/AppDelegate.swift`); the chosen action reaches
 *     `nativePush.ts` as `pushNotificationActionPerformed` with `actionId`
 *     "done" or "snooze".
 *   - Web push: buttons on the notification (`public/push-handler.js`); the
 *     worker has no session, so it posts the choice to an open page — or to
 *     the page it opens — as a message of type {@link PUSH_ACTION_MESSAGE_TYPE},
 *     and this module receives it on `navigator.serviceWorker`.
 *   - Android: no buttons yet (an FCM notification message is rendered by the
 *     system); a tap still opens the task's plant.
 *
 * Either way the request lands in {@link performPushAction}, which posts to
 * the task's own complete / snooze endpoint with the app's stored session.
 * Nothing in the notification is a credential, and nothing in it is trusted
 * for authorization: the server decides, exactly as for a tap in the app.
 *
 * Idempotent by construction: the request echoes the occurrence's due date
 * as `expectedNextDue`, so a second Done on the same notification — a retry,
 * a tap on a phone and a laptop, a reminder answered after someone else did
 * it — is a no-op on the server. Failing safely: a request that cannot be
 * made (no session, offline, the app suspended before it ran) changes
 * nothing, and the task stays exactly where the app shows it.
 *
 * The part that talks to the server is `pushActionRunner.ts`, kept apart so
 * its tests can stand in for the API without this module's listener and
 * validation in the way. It is a static import: the entry chunk has room,
 * and a separate lazy chunk cost more in chunk boilerplate than the code.
 */

/**
 * The action identifiers, as the service worker names its buttons, as the
 * iOS category names its `UNNotificationAction`s, and as the backend labels
 * them (`notifier.PushActionLabels`). All four must agree.
 */
export const PUSH_ACTION_IDS = ['done', 'snooze'] as const;
export type PushActionId = (typeof PUSH_ACTION_IDS)[number];

/** The `type` of the message the service worker posts to a page. */
export const PUSH_ACTION_MESSAGE_TYPE = 'fg:push-action';

/** "Snooze until tomorrow" is one day, on every platform. */
export { SNOOZE_DAYS };

export interface PushTaskRef {
  taskId: string;
  plantId?: string;
  /** The occurrence the reminder was about; the server's retry token. */
  expectedNextDue?: string;
}

export interface PushActionRequest extends PushTaskRef {
  action: PushActionId;
}

/**
 * What happened. `already` means the server accepted the request but the
 * occurrence had moved on before it (someone else did it, or an earlier
 * tap), so nothing changed; `failed` means no change could be made.
 */
export type PushActionOutcome = 'done' | 'snoozed' | 'already' | 'failed';

let queryClient: QueryClient | null = null;
let listening = false;

/** The action id a platform reported, or null for a tap, a dismissal, or anything unknown. */
export function pushActionFromId(id: unknown): PushActionId | null {
  return typeof id === 'string' && (PUSH_ACTION_IDS as readonly string[]).includes(id)
    ? (id as PushActionId)
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The task a notification's data names, or null when it names none. Reads
 * the three id fields by name and nothing else, so a payload cannot smuggle
 * anything into the request.
 */
export function readPushTaskRef(data: unknown): PushTaskRef | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (!nonEmptyString(record.taskId)) return null;
  const task: PushTaskRef = { taskId: record.taskId };
  if (nonEmptyString(record.plantId)) task.plantId = record.plantId;
  if (nonEmptyString(record.expectedNextDue)) task.expectedNextDue = record.expectedNextDue;
  return task;
}

/** A service-worker message as a request, or null for any other message. */
export function readPushActionMessage(data: unknown): PushActionRequest | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (record.type !== PUSH_ACTION_MESSAGE_TYPE) return null;
  const action = pushActionFromId(record.action);
  const task = readPushTaskRef(record);
  return action && task ? { action, ...task } : null;
}

/**
 * Perform one action with the app's own session. Resolves to the outcome
 * and never rejects: a notification handler has nowhere to report a throw.
 */
export async function performPushAction(request: PushActionRequest): Promise<PushActionOutcome> {
  try {
    return await runPushAction(request, queryClient);
  } catch (cause) {
    console.warn('Push action could not run', cause);
    return 'failed';
  }
}

function onWorkerMessage(event: MessageEvent): void {
  const request = readPushActionMessage(event.data);
  if (request) void performPushAction(request);
}

/**
 * Wire the web-push side: listen for the worker's messages on
 * `navigator.serviceWorker`. The native shells do not register a worker and
 * get their actions through `nativePush.ts`, which calls
 * {@link performPushAction} directly; both need the query client so the
 * lists on screen refresh after an action lands.
 *
 * `startMessages()` matters: a page opened BY the worker for an action has
 * the message queued until it starts them, and `addEventListener` alone does
 * not (only assigning `onmessage` does), so a cold-opened page would never
 * hear the action it was opened for.
 */
export function initPushActions(client: QueryClient): void {
  queryClient = client;
  if (listening || isNativeApp()) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  listening = true;
  navigator.serviceWorker.addEventListener('message', onWorkerMessage);
  navigator.serviceWorker.startMessages?.();
}

/** Test seam: module state would otherwise leak between cases. */
export function __resetPushActionsForTests(): void {
  if (listening && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.removeEventListener('message', onWorkerMessage);
  }
  listening = false;
  queryClient = null;
}
