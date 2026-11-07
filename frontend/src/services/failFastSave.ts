import { onlineManager } from '@tanstack/react-query';
import i18n from '@/i18n';
import { getErrorMessage } from '@/services/api';

/**
 * Saves that fail fast instead of waiting for the network.
 *
 * TanStack Query pauses a mutation while the browser reports offline
 * (`networkMode: 'online'`, the default) and resumes it on reconnect. For a
 * form save that meant a spinner with no end, a Cancel that left the create
 * queued behind the user's back (a plant re-added meanwhile came back
 * twice), and a snooze whose sheet closed with nothing changed and nothing
 * said. Nothing on screen read `isPaused`, so a paused save looked exactly
 * like a slow one.
 *
 * These saves now never pause. Offline, they refuse before sending anything,
 * so "nothing was saved" is a fact rather than a guess. Online, the request
 * goes out and an unanswered one fails with the existing "Can't reach"
 * message. Either way the form keeps what was typed so the user can retry.
 * There is deliberately no queue.
 */
export class OfflineSaveError extends Error {
  constructor() {
    super(i18n.t('connection.saveOffline'));
    this.name = 'OfflineSaveError';
  }
}

/** Throws `OfflineSaveError` when the device reports no network. */
export function assertOnlineForSave(): void {
  if (!onlineManager.isOnline()) throw new OfflineSaveError();
}

/**
 * Mutation options for a save that must not pause: spread into `useMutation`.
 * The offline check runs first, before any read the save depends on.
 */
export function failFastSave<TVariables, TData>(
  save: (variables: TVariables) => Promise<TData>
): { networkMode: 'always'; mutationFn: (variables: TVariables) => Promise<TData> } {
  return {
    networkMode: 'always',
    mutationFn: async (variables: TVariables) => {
      assertOnlineForSave();
      return save(variables);
    },
  };
}

/** The message for a failed save: the offline refusal, or the usual server message. */
export function saveErrorMessage(error: unknown): string {
  if (error instanceof OfflineSaveError) return i18n.t('connection.saveOffline');
  return getErrorMessage(error);
}
