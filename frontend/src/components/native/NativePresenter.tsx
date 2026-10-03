import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { NativeChrome } from '@/services/nativeChrome';
import { TRASH_RETENTION_DAYS } from '@/services/trashService';
import { nextPresentToken, recentAnchor } from '@/services/nativePresent';
import {
  chosenAction,
  confirmRequest,
  removePlantRequest,
  type NativePresentRequest,
  type RemovePlantChoice,
} from '@/config/nativePresent';

/**
 * The app's confirmations and choices as Apple's own alerts and action
 * sheets (NativeChrome `present`), inside the iOS app only. A lazy chunk: the
 * website never downloads it (components/NativeDialog.tsx loads it behind
 * `hasNativePresent()`).
 *
 * Each dialog keeps its web props (`isOpen`, `onClose`, `onConfirm`, …), so
 * its callers do not change. Only a tap on a button that is not Cancel calls
 * the dialog's action; everything else that ends an alert (Cancel, a tap
 * outside, a swipe, the app going to the background) calls `onClose`, which
 * is what the web dialog's Cancel, Escape and scrim do.
 */

const noop = () => undefined;

type Request = Omit<NativePresentRequest, 'token'>;

interface Showing {
  token: string;
  request: Request;
  answered: boolean;
}

/**
 * Shows `request` natively while `isOpen` is true; one alert per opening.
 *
 * - Opening presents it; closing it from the web (or unmounting) dismisses
 *   it, which answers no choice and is ignored here.
 * - New words while it shows (a count that arrived) go to `updatePresented`.
 * - An alert closes when it is tapped, but a web dialog stays open while its
 *   action runs and after it fails. So when an action has finished
 *   (`isLoading` true, then false) and the caller still has the dialog open,
 *   it is closed with `onCancel`, and the button that opened it works again.
 */
function useNativePresentation(options: {
  isOpen: boolean;
  isLoading: boolean;
  request: Request;
  onChoice: (id: string) => void;
  onCancel: () => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const showing = useRef<Showing | null>(null);
  const wasLoading = useRef(options.isLoading);

  useEffect(() => {
    if (!options.isOpen) {
      const current = showing.current;
      showing.current = null;
      if (current && !current.answered) {
        void NativeChrome.dismissPresented({ token: current.token }).catch(noop);
      }
      return;
    }
    if (showing.current) return;
    const request = latest.current.request;
    const current: Showing = { token: nextPresentToken(), request, answered: false };
    showing.current = current;
    const settle = (result: unknown) => {
      // Closed or replaced in the meantime: not this alert's answer to give.
      if (showing.current !== current || current.answered) return;
      current.answered = true;
      const id = chosenAction(request, result);
      if (id) latest.current.onChoice(id);
      else latest.current.onCancel();
    };
    const anchor = request.kind === 'actionSheet' ? recentAnchor() : undefined;
    NativeChrome.present({ ...request, token: current.token, anchor }).then(settle, () =>
      settle(null)
    );
  }, [options.isOpen]);

  useEffect(
    () => () => {
      const current = showing.current;
      showing.current = null;
      if (current && !current.answered) {
        void NativeChrome.dismissPresented({ token: current.token }).catch(noop);
      }
    },
    []
  );

  const { title, message } = options.request;
  useEffect(() => {
    const current = showing.current;
    if (!current || current.answered) return;
    if (current.request.title === title && current.request.message === message) return;
    current.request = { ...current.request, title, message };
    void NativeChrome.updatePresented({ token: current.token, title, message }).catch(noop);
  }, [title, message]);

  useEffect(() => {
    const finished = wasLoading.current && !options.isLoading;
    wasLoading.current = options.isLoading;
    if (!finished) return;
    const current = showing.current;
    if (!current?.answered) return;
    // One turn later, so a caller that closes in the same update is seen first.
    const timer = setTimeout(() => {
      const now = latest.current;
      if (showing.current === current && now.isOpen && !now.isLoading) now.onCancel();
    }, 0);
    return () => clearTimeout(timer);
  }, [options.isLoading]);
}

export interface NativeConfirmProps {
  kind: 'confirm';
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  variant: 'danger' | 'primary';
  isLoading: boolean;
}

function NativeConfirm(props: NativeConfirmProps) {
  useNativePresentation({
    isOpen: props.isOpen,
    isLoading: props.isLoading,
    request: confirmRequest(props),
    onChoice: () => props.onConfirm(),
    onCancel: () => props.onClose(),
  });
  return null;
}

export interface NativeRemovePlantProps {
  kind: 'removePlant';
  isOpen: boolean;
  plantName: string;
  isLoading: boolean;
  onClose: () => void;
  onArchive: () => void;
  onDied: () => void;
  onGaveAway: () => void;
  passportTo?: string;
  onDelete: () => void;
}

function NativeRemovePlant(props: NativeRemovePlantProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const request = removePlantRequest({
    title: t('plants.archive.dialogTitle', { name: props.plantName }),
    message: t('plants.archive.dialogDescription'),
    archive: t('plants.archive.action'),
    gaveAway: t('plants.archive.gaveAway'),
    passport: props.passportTo ? t('plants.archive.passportLink') : undefined,
    died: t('plants.archive.died'),
    moveToTrash: t('plants.archive.moveToTrash', { days: TRASH_RETENTION_DAYS }),
    cancel: t('common.cancel'),
  });
  useNativePresentation({
    isOpen: props.isOpen,
    isLoading: props.isLoading,
    request,
    onChoice: (id) => {
      switch (id as RemovePlantChoice) {
        case 'archive':
          return props.onArchive();
        case 'gaveAway':
          return props.onGaveAway();
        case 'died':
          return props.onDied();
        case 'delete':
          // Its own second confirmation follows (PlantDetailPage).
          return props.onDelete();
        case 'passport':
          props.onClose();
          if (props.passportTo) navigate(props.passportTo);
          return;
        default:
          return props.onClose();
      }
    },
    onCancel: () => props.onClose(),
  });
  return null;
}

export type NativeDialogProps = NativeConfirmProps | NativeRemovePlantProps;

/** The dialog kinds that open natively; NativeDialog.tsx renders this lazily. */
export default function NativePresenter(props: NativeDialogProps) {
  return props.kind === 'confirm' ? <NativeConfirm {...props} /> : <NativeRemovePlant {...props} />;
}
