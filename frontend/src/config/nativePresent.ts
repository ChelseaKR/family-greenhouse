/**
 * Apple's own alerts and action sheets for the web, inside the iOS app: the
 * messages for NativeChrome's `present` (ios/App/App/NativePresentModel.swift
 * and NativeFrameController.swift), and the requests the app's dialogs send.
 *
 * Inside the native frame a web dialog opens between the native bars, with
 * the tab bar still live under its scrim. Confirmations and choices are what
 * UIAlertController is for, so in the app they go native; the website keeps
 * its dialogs (components/ConfirmDialog.tsx and the rest render them as
 * before whenever `hasNativePresent()` is false).
 *
 * The safety rule, kept on both sides of the bridge: only a tap on a button
 * that is not the cancel button is a choice. Swift answers `{ id: null }` for
 * every other ending (Cancel, a tap outside, a swipe, the app going to the
 * background, the web closing it), and `chosenAction` below accepts an id only
 * if it names a non-cancel action of the request that was sent.
 *
 * This file is imported only by the native presenter (a lazy chunk the
 * website never loads) and by the tests.
 */

export type NativePresentKind = 'alert' | 'actionSheet';
export type NativePresentStyle = 'default' | 'destructive' | 'cancel';

export interface NativePresentAction {
  id: string;
  title: string;
  style: NativePresentStyle;
}

/** The web view rectangle (CSS pixels, from getBoundingClientRect) a sheet points at on iPad. */
export interface NativePresentAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `present`: web -> native, answered with a NativePresentResult. */
export interface NativePresentRequest {
  /** Names this presentation, for `updatePresented` and `dismissPresented`. */
  token: string;
  kind: NativePresentKind;
  title?: string;
  message?: string;
  /** In order. Exactly one `cancel`; at least one other. */
  actions: NativePresentAction[];
  anchor?: NativePresentAnchor;
}

/** `present`'s answer: the tapped action's id, or null for no choice. */
export interface NativePresentResult {
  id: string | null;
}

/** `updatePresented`: new words for the one showing (web -> native). */
export interface NativePresentUpdate {
  token: string;
  title?: string;
  message?: string;
}

export const CANCEL_ACTION_ID = 'cancel';
export const MAX_PRESENT_ACTIONS = 10;

/**
 * Why Swift would refuse this request, or null when it would show it. The
 * same rules as PresentRequest.parse in NativePresentModel.swift.
 */
export function presentProblem(request: Omit<NativePresentRequest, 'token'>): string | null {
  if (request.kind !== 'alert' && request.kind !== 'actionSheet') return 'kind';
  if (request.kind === 'alert' && !request.title?.trim() && !request.message?.trim()) {
    return 'an alert needs a title or a message';
  }
  const { actions } = request;
  if (actions.length === 0 || actions.length > MAX_PRESENT_ACTIONS) return 'action count';
  if (new Set(actions.map((a) => a.id)).size !== actions.length) return 'duplicate ids';
  if (actions.some((a) => !a.id || !a.title.trim())) return 'blank action';
  if (actions.filter((a) => a.style === 'cancel').length !== 1) return 'exactly one cancel';
  if (!actions.some((a) => a.style !== 'cancel')) return 'nothing to choose';
  return null;
}

/**
 * The action the person chose, or null. An id counts only when it names one
 * of the request's own actions that is not the cancel action: an unknown id,
 * the cancel action's id, null, or anything malformed is no choice.
 */
export function chosenAction(
  request: Pick<NativePresentRequest, 'actions'>,
  result: unknown
): string | null {
  const id = (result as { id?: unknown } | null | undefined)?.id;
  if (typeof id !== 'string') return null;
  const action = request.actions.find((a) => a.id === id);
  return action && action.style !== 'cancel' ? action.id : null;
}

/** ConfirmDialog's request: the confirm button, then Cancel. */
export function confirmRequest(input: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  variant: 'danger' | 'primary';
}): Omit<NativePresentRequest, 'token'> {
  return {
    kind: 'alert',
    title: input.title,
    message: input.message,
    actions: [
      {
        id: 'confirm',
        title: input.confirmLabel,
        style: input.variant === 'danger' ? 'destructive' : 'default',
      },
      { id: CANCEL_ACTION_ID, title: input.cancelLabel, style: 'cancel' },
    ],
  };
}

/** The Remove plant choices (RemovePlantDialog), as an action sheet. */
export type RemovePlantChoice = 'archive' | 'gaveAway' | 'passport' | 'died' | 'delete';

export function removePlantRequest(input: {
  title: string;
  message: string;
  archive: string;
  gaveAway: string;
  /** Present only when the plant has a passport to print. */
  passport?: string;
  died: string;
  moveToTrash: string;
  cancel: string;
}): Omit<NativePresentRequest, 'token'> {
  const actions: NativePresentAction[] = [
    { id: 'archive', title: input.archive, style: 'default' },
    { id: 'gaveAway', title: input.gaveAway, style: 'default' },
  ];
  if (input.passport) actions.push({ id: 'passport', title: input.passport, style: 'default' });
  actions.push(
    { id: 'died', title: input.died, style: 'default' },
    // Only into the trash, and only after a second confirmation.
    { id: 'delete', title: input.moveToTrash, style: 'destructive' },
    { id: CANCEL_ACTION_ID, title: input.cancel, style: 'cancel' }
  );
  return { kind: 'actionSheet', title: input.title, message: input.message, actions };
}

/** A menu (the snooze durations) as an action sheet: one action per option. */
export function menuRequest(input: {
  title?: string;
  options: ReadonlyArray<{ id: string; title: string }>;
  cancel: string;
}): Omit<NativePresentRequest, 'token'> {
  return {
    kind: 'actionSheet',
    title: input.title,
    actions: [
      ...input.options.map((o) => ({ id: o.id, title: o.title, style: 'default' as const })),
      { id: CANCEL_ACTION_ID, title: input.cancel, style: 'cancel' },
    ],
  };
}
