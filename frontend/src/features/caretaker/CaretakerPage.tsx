import { useCallback, useEffect, useRef, useState } from 'react';
import { hasNativePresent } from '@/lib/platform';
import {
  canUseNativeCamera,
  nativePhotoErrorMessage,
  pickNativePhoto,
} from '@/services/nativeCamera';
import { chooseFromMenu } from '@/services/nativePresent';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CameraIcon, MapPinIcon } from '@heroicons/react/24/outline';
import { PublicShell } from '@/components/PublicShell';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useMetaTags } from '@/hooks/useMetaTags';
import {
  caretakerVisitService,
  CaretakerLinkInactiveError,
  type CaretakerTask,
} from '@/services/caretakerVisitService';
import { formatDate } from '@/i18n/format';
import { dueDayOffset } from '@/utils/date';

/**
 * The caretaker's page: /caretaker/{token}. No account, no sign-in.
 *
 * Three actions, matching the server's permission surface exactly — tick a
 * task off, add a photo, leave a note — and the page says up front that every
 * one of them is logged under the caretaker's name. That transparency is not
 * decoration: the household's proof-of-visit report is built from these
 * actions, so the person taking them should know they are on the record.
 *
 * Failure states are distinguished rather than collapsed: an expired seat, a
 * failed load, a failed action and "the action worked but its line on the
 * visit record did not" are four different messages, because the household's
 * record is the product and a silent gap in it is the defect this codebase
 * names "absence rendered as a value".
 */
type Status = 'loading' | 'ready' | 'inactive' | 'error';

function useInstruction() {
  const { t } = useTranslation();
  return (task: CaretakerTask): string => {
    const plant = task.plantName;
    switch (task.taskType) {
      case 'water':
        return t('caretaker.page.instructionWater', { plant });
      case 'fertilize':
        return t('caretaker.page.instructionFeed', { plant });
      case 'prune':
        return t('caretaker.page.instructionPrune', { plant });
      case 'repot':
        return t('caretaker.page.instructionRepot', { plant });
      default:
        // Custom task types come through as free text — show them as-is.
        return t('caretaker.page.instructionOther', { task: task.taskType, plant });
    }
  };
}

export function CaretakerPage() {
  const { token = '' } = useParams<{ token: string }>();
  const { t } = useTranslation();
  const instructionFor = useInstruction();

  useMetaTags({
    title: t('caretaker.page.metaTitle'),
    description: t('caretaker.page.metaDescription'),
  });

  const [caretakerName, setCaretakerName] = useState('');
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [tasks, setTasks] = useState<CaretakerTask[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [recordGap, setRecordGap] = useState(false);
  // What the live region says when a row disappears, and where focus goes.
  // The same pattern as the sitter page (features/sitter/SitPage.tsx).
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [justCompleted, setJustCompleted] = useState<{ taskId: string; seq: number } | null>(null);
  const completionSeq = useRef(0);
  const doneButtons = useRef(new Map<string, HTMLButtonElement>());
  const summaryRef = useRef<HTMLDivElement>(null);

  const [noteText, setNoteText] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteSaved, setNoteSaved] = useState(false);

  const [photoTaskId, setPhotoTaskId] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoDone, setPhotoDone] = useState<Set<string>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    caretakerVisitService
      .getView(token, controller.signal)
      .then((view) => {
        setCaretakerName(view.caretakerName);
        setExpiresAt(view.expiresAt);
        setTasks(view.tasks);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setStatus(err instanceof CaretakerLinkInactiveError ? 'inactive' : 'error');
      });
    return () => controller.abort();
  }, [token]);

  const handleComplete = useCallback(
    async (task: CaretakerTask) => {
      setActionError(null);
      setPending((p) => new Set(p).add(task.taskId));
      try {
        const result = await caretakerVisitService.completeTask(token, task.taskId, task.dueDate);
        setDone((d) => new Set(d).add(task.taskId));
        if (!result.visitRecorded) setRecordGap(true);
        // The row is about to be removed, and it takes two things with it:
        // the words (a live region announces insertions, never removals) and
        // the focus (the removed <li> held it, so it falls to <body>). Both
        // are replaced here, exactly as the sitter page does.
        setStatusMessage(t('sitter.markedDone', { plant: task.plantName }));
        setJustCompleted({ taskId: task.taskId, seq: completionSeq.current++ });
      } catch (err) {
        if (err instanceof CaretakerLinkInactiveError) {
          setStatus('inactive');
          return;
        }
        // Leave the task actionable so it can be retried.
        setActionError(t('caretaker.page.errorBody'));
      } finally {
        setPending((p) => {
          const next = new Set(p);
          next.delete(task.taskId);
          return next;
        });
      }
    },
    [t, token]
  );

  // Move focus to the next task's Done button once the completed row is gone,
  // or to the closing summary when that was the last one. Runs after the
  // render that removed the row, and is keyed on a counter rather than on the
  // task id so that every completion moves focus.
  useEffect(() => {
    if (!justCompleted) return;
    const order = tasks.map((task) => task.taskId);
    const from = order.indexOf(justCompleted.taskId);
    const nextId =
      order.slice(from + 1).find((id) => !done.has(id)) ??
      order.find((id) => !done.has(id)) ??
      null;
    const target = nextId ? doneButtons.current.get(nextId) : summaryRef.current;
    target?.focus();
  }, [done, justCompleted, tasks]);

  const handlePhotoPicked = useCallback(
    async (file: File | undefined, forTaskId: string | null = photoTaskId) => {
      const task = tasks.find((candidate) => candidate.taskId === forTaskId);
      setPhotoTaskId(null);
      if (!file || !task) return;
      setActionError(null);
      setPhotoBusy(true);
      try {
        const result = await caretakerVisitService.addPhoto(token, task.plantId, file);
        setPhotoDone((p) => new Set(p).add(task.taskId));
        if (!result.visitRecorded) setRecordGap(true);
      } catch (err) {
        if (err instanceof CaretakerLinkInactiveError) {
          setStatus('inactive');
          return;
        }
        setActionError(t('caretaker.page.photoFailed'));
      } finally {
        setPhotoBusy(false);
      }
    },
    [photoTaskId, t, tasks, token]
  );

  /** In the apps: Apple's sheet asks camera or library, then straight there. */
  const addNativePhoto = async (taskId: string, from: Element) => {
    const source = await chooseFromMenu({
      title: t('caretaker.page.addPhoto'),
      options: [
        { id: 'camera', title: t('plants.photoPicker.take') },
        { id: 'library', title: t('plants.photoPicker.choose') },
      ],
      cancel: t('common.cancel'),
      from,
    });
    if (source !== 'camera' && source !== 'library') {
      setPhotoTaskId(null);
      return;
    }
    try {
      const file = await pickNativePhoto(source);
      if (!file) {
        setPhotoTaskId(null);
        return;
      }
      await handlePhotoPicked(file, taskId);
    } catch (error) {
      setPhotoTaskId(null);
      setActionError(nativePhotoErrorMessage(error, t));
    }
  };

  const handleNote = useCallback(async () => {
    const text = noteText.trim();
    if (!text) return;
    setActionError(null);
    setNoteSaving(true);
    try {
      await caretakerVisitService.addNote(token, text);
      setNoteText('');
      setNoteSaved(true);
    } catch (err) {
      if (err instanceof CaretakerLinkInactiveError) {
        setStatus('inactive');
        return;
      }
      setActionError(t('caretaker.page.noteFailed'));
    } finally {
      setNoteSaving(false);
    }
  }, [noteText, t, token]);

  // The calendar day in this browser's zone, as every signed-in page reads it,
  // not the API's instant-rule `overdue` flag, which called a task due at 09:00
  // "Overdue" from 09:01 (see `dueDayOffset`). `null` shows no label.
  const now = new Date();
  const dueLabel = (days: number | null): string | null => {
    if (days === null) return null;
    if (days < 0) return t('caretaker.page.overdue');
    if (days === 0) return t('caretaker.page.dueToday');
    if (days === 1) return t('caretaker.page.dueTomorrow');
    return t('caretaker.page.dueInDays', { count: days });
  };

  const remaining = tasks.filter((task) => !done.has(task.taskId));
  // "You finished the list" and "the list was empty when you arrived" both
  // make `remaining` empty, and they are not the same claim. Only the first
  // has a caretaker's name on anything, so only the first gets the thank-you
  // and the promise that the household will see it (#604).
  const finishedSomething = done.size > 0;

  return (
    <PublicShell width="article" plainHeader>
      {status === 'loading' && (
        <div className="flex min-h-[40vh] items-center justify-center" role="status">
          <LoadingSpinner size="lg" />
          <span className="sr-only">{t('caretaker.page.loading')}</span>
        </div>
      )}

      {status === 'inactive' && (
        <div className="mt-8">
          <Alert variant="info" title={t('caretaker.page.inactiveTitle')}>
            {t('caretaker.page.inactiveBody')}
          </Alert>
        </div>
      )}

      {status === 'error' && (
        <div className="mt-8">
          <Alert variant="error" title={t('caretaker.page.errorTitle')}>
            {t('caretaker.page.errorBody')}
          </Alert>
        </div>
      )}

      {status === 'ready' && (
        <>
          <h1 className="font-serif text-3xl tracking-tight text-ink sm:text-4xl">
            {t('caretaker.page.greeting', { name: caretakerName })}
          </h1>
          <p className="mt-3 text-base text-gray-600">{t('caretaker.page.attribution')}</p>
          {expiresAt && (
            <p className="mt-2 text-sm text-gray-600">
              {t('caretaker.page.coveringUntil', { date: formatDate(expiresAt) })}
            </p>
          )}

          {recordGap && (
            <Alert variant="warning" className="mt-4">
              {t('caretaker.page.visitNotRecorded')}
            </Alert>
          )}
          {actionError && (
            <Alert variant="error" className="mt-4">
              {actionError}
            </Alert>
          )}

          {/* The wrapper owns this announcement — completing the last task
              replaces the list with the Alert, which is one change. The Alert
              passes live="off" so its own role="status" does not nest a polite
              region inside this polite region and announce twice. */}
          <div className="mt-10 space-y-3" aria-live="polite">
            {/* Inserted, not toggled: this region reports additions, so the
                sentence about the row that just left has to arrive as new
                content. The key makes a repeat of the same sentence (a second
                task on one plant) a new node too. Plain <p>, no role: a
                second live region nested in this one would announce twice. */}
            {statusMessage && justCompleted && (
              <p key={justCompleted.seq} className="sr-only">
                {statusMessage}
              </p>
            )}
            {remaining.length === 0 ? (
              <div ref={summaryRef} tabIndex={-1} className="focus:outline-hidden">
                {finishedSomething ? (
                  <Alert variant="success" title={t('caretaker.page.allDoneTitle')} live="off">
                    {t('caretaker.page.allDoneBody')}
                  </Alert>
                ) : (
                  <Alert variant="info" title={t('caretaker.page.nothingDueTitle')} live="off">
                    {t('caretaker.page.nothingDueBody')}
                  </Alert>
                )}
              </div>
            ) : (
              <ul className="space-y-3">
                {remaining.map((task) => {
                  const location = [task.spaceName, task.placementNote].filter(Boolean).join(' · ');
                  const instruction = instructionFor(task);
                  const days = dueDayOffset(task.dueDate, now);
                  const label = dueLabel(days);
                  return (
                    <li
                      key={task.taskId}
                      className="rounded-xl border border-primary-100/80 bg-white p-4 shadow-journal"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <p className="font-medium text-gray-900">{instruction}</p>
                          {location && (
                            <p className="mt-1 flex items-start gap-1 text-sm text-primary-800">
                              <MapPinIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                              <span>{location}</span>
                            </p>
                          )}
                          {label && (
                            <p
                              className={
                                'mt-0.5 text-sm ' +
                                (days !== null && days < 0 ? 'text-amber-700' : 'text-gray-600')
                              }
                            >
                              {label}
                            </p>
                          )}
                        </div>
                        <Button
                          ref={(node) => {
                            if (node) doneButtons.current.set(task.taskId, node);
                            else doneButtons.current.delete(task.taskId);
                          }}
                          variant="primary"
                          size="sm"
                          isLoading={pending.has(task.taskId)}
                          onClick={() => handleComplete(task)}
                          aria-label={t('caretaker.page.doneAria', { task: instruction })}
                        >
                          {t('caretaker.page.done')}
                        </Button>
                      </div>
                      <div className="mt-3 flex items-center gap-3">
                        <Button
                          variant="secondary"
                          size="sm"
                          isLoading={photoBusy && photoTaskId === task.taskId}
                          leftIcon={<CameraIcon className="h-4 w-4" aria-hidden="true" />}
                          onClick={(event) => {
                            setPhotoTaskId(task.taskId);
                            // An app without Apple's sheets keeps the picker.
                            if (canUseNativeCamera() && hasNativePresent())
                              void addNativePhoto(task.taskId, event.currentTarget);
                            else fileInput.current?.click();
                          }}
                          aria-label={t('caretaker.page.addPhotoAria', { plant: task.plantName })}
                        >
                          {t('caretaker.page.addPhoto')}
                        </Button>
                        {photoDone.has(task.taskId) && (
                          <span className="text-sm text-primary-800">
                            {t('caretaker.page.photoAdded')}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* One hidden picker for every row; the row that opened it is held
              in state so the upload attaches to the right plant. */}
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              void handlePhotoPicked(file);
            }}
          />
          {photoBusy && (
            <p className="mt-3 text-sm text-gray-600" role="status">
              {t('caretaker.page.photoUploading')}
            </p>
          )}

          <section className="mt-10 rounded-xl border border-primary-100/80 bg-white p-4 shadow-journal">
            <h2 className="text-base font-medium text-gray-900">{t('caretaker.page.noteTitle')}</h2>
            <label className="mt-2 block text-sm text-gray-700" htmlFor="caretaker-note">
              {t('caretaker.page.noteLabel')}
            </label>
            <textarea
              id="caretaker-note"
              className="input mt-1 w-full"
              rows={3}
              maxLength={500}
              value={noteText}
              placeholder={t('caretaker.page.notePlaceholder')}
              onChange={(e) => {
                setNoteText(e.target.value);
                setNoteSaved(false);
              }}
            />
            <div className="mt-2 flex items-center gap-3">
              <Button
                size="sm"
                isLoading={noteSaving}
                disabled={noteText.trim().length === 0}
                onClick={() => void handleNote()}
              >
                {t('caretaker.page.noteSave')}
              </Button>
              {noteSaved && (
                <span className="text-sm text-primary-800" role="status">
                  {t('caretaker.page.noteSaved')}
                </span>
              )}
            </div>
          </section>

          <p className="mt-10 text-sm text-gray-600">
            <Link to="/" className="text-primary-700 underline hover:text-primary-800">
              Family Greenhouse
            </Link>{' '}
            {t('caretaker.page.footer')}
          </p>
        </>
      )}
    </PublicShell>
  );
}
