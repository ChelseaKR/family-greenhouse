import { useCallback, useEffect, useRef, useState } from 'react';
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

  const handlePhotoPicked = useCallback(
    async (file: File | undefined) => {
      const task = tasks.find((candidate) => candidate.taskId === photoTaskId);
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

  const now = Date.now();
  const dueLabel = (task: CaretakerTask): string => {
    if (task.overdue) return t('caretaker.page.overdue');
    const days = Math.round((new Date(task.dueDate).getTime() - now) / (24 * 60 * 60 * 1000));
    if (days <= 0) return t('caretaker.page.dueToday');
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
            {remaining.length === 0 ? (
              finishedSomething ? (
                <Alert variant="success" title={t('caretaker.page.allDoneTitle')} live="off">
                  {t('caretaker.page.allDoneBody')}
                </Alert>
              ) : (
                <Alert variant="info" title={t('caretaker.page.nothingDueTitle')} live="off">
                  {t('caretaker.page.nothingDueBody')}
                </Alert>
              )
            ) : (
              <ul className="space-y-3">
                {remaining.map((task) => {
                  const location = [task.spaceName, task.placementNote].filter(Boolean).join(' · ');
                  const instruction = instructionFor(task);
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
                          <p
                            className={
                              'mt-0.5 text-sm ' +
                              (task.overdue ? 'text-amber-700' : 'text-gray-600')
                            }
                          >
                            {dueLabel(task)}
                          </p>
                        </div>
                        <Button
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
                          onClick={() => {
                            setPhotoTaskId(task.taskId);
                            fileInput.current?.click();
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
