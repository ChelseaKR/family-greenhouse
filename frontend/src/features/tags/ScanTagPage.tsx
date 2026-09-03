import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PublicShell } from '@/components/PublicShell';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useMetaTags } from '@/hooks/useMetaTags';
import { formatRelativeDay } from '@/i18n/format';
import {
  publicTagService,
  TagInactiveError,
  TagLockedError,
  TagPinError,
  TAG_NAME_STORAGE_KEY,
  type TagCare,
  type TagDueTask,
  type TagView,
} from '@/services/plantTagService';

/**
 * The public plant-tag scan page (ADR 0016) — the whole point of the feature.
 *
 * Someone in the house points a phone camera at the label in the pot and
 * lands here. No account, no app, no invite: they see what the plant is, when
 * it was last watered and by whom, the household's own care conventions, and
 * one button that marks the due task done under a name they type once.
 *
 * Two honesty rules the page is built around:
 *   - A care-history read that FAILED says so. "Never watered" is a claim
 *     about the plant; a failed read is a claim about us, and rendering the
 *     first when we mean the second is this repo's named defect (ADR 0010).
 *   - The completion is attributed to the typed name, not to nobody. The
 *     household's feed says "Grandma watered the Monstera", which is the
 *     activation event the whole feature exists to create.
 */

type Status = 'loading' | 'ready' | 'pin' | 'locked' | 'inactive' | 'error';

function readStoredName(): string {
  try {
    return localStorage.getItem(TAG_NAME_STORAGE_KEY) ?? '';
  } catch {
    // Private mode / blocked storage: the scanner just types their name again.
    return '';
  }
}

function rememberName(name: string): void {
  try {
    localStorage.setItem(TAG_NAME_STORAGE_KEY, name);
  } catch {
    // Nothing to do — remembering the name is a convenience, not the feature.
  }
}

export function ScanTagPage() {
  const { token = '' } = useParams<{ token: string }>();
  const { t } = useTranslation();

  useMetaTags({
    title: t('plantTags.scan.metaTitle'),
    description: t('plantTags.scan.metaDescription'),
    // A tokenized, per-plant URL must never be indexed.
    robots: 'noindex, nofollow',
  });

  const [view, setView] = useState<TagView | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [pin, setPin] = useState('');
  const [pinDraft, setPinDraft] = useState('');
  const [pinWrong, setPinWrong] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<string | null>(null);
  const [name, setName] = useState(readStoredName);
  const [nameError, setNameError] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [thanks, setThanks] = useState<string | null>(null);
  const [completionFailed, setCompletionFailed] = useState(false);

  const load = useCallback(
    (withPin: string, signal?: AbortSignal) => {
      setStatus('loading');
      publicTagService
        .getView(token, withPin || undefined, signal)
        .then((next) => {
          setView(next);
          setPin(withPin);
          setPinWrong(false);
          setStatus('ready');
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          if (err instanceof TagInactiveError) return setStatus('inactive');
          if (err instanceof TagLockedError) {
            setLockedUntil(err.lockedUntil);
            return setStatus('locked');
          }
          if (err instanceof TagPinError) {
            setPinWrong(err.reason === 'wrong');
            return setStatus('pin');
          }
          setStatus('error');
        });
    },
    [token]
  );

  useEffect(() => {
    const controller = new AbortController();
    load('', controller.signal);
    return () => controller.abort();
  }, [load]);

  const handleComplete = useCallback(
    async (task: TagDueTask) => {
      const trimmed = name.trim();
      if (!trimmed) {
        setNameError(true);
        return;
      }
      setNameError(false);
      setCompletionFailed(false);
      setPending(task.taskId);
      try {
        const result = await publicTagService.completeTask({
          token,
          taskId: task.taskId,
          displayName: trimmed,
          expectedNextDue: task.dueDate,
          pin: pin || undefined,
        });
        rememberName(trimmed);
        setDoneIds((prev) => new Set(prev).add(task.taskId));
        setThanks(result.completedByName);
      } catch (err) {
        if (err instanceof TagInactiveError) return setStatus('inactive');
        if (err instanceof TagLockedError) {
          setLockedUntil(err.lockedUntil);
          return setStatus('locked');
        }
        if (err instanceof TagPinError) {
          setPinWrong(err.reason === 'wrong');
          return setStatus('pin');
        }
        // Leave the task actionable so it can simply be tapped again.
        setCompletionFailed(true);
      } finally {
        setPending(null);
      }
    },
    [name, pin, token]
  );

  const careLine = (care: TagCare, waterOnly: boolean): string => {
    const taskLabel = t(`tasks.types.${care.taskType}`, { defaultValue: care.taskType });
    return waterOnly
      ? t('plantTags.scan.lastWatered', {
          when: formatRelativeDay(care.completedAt),
          name: care.completedByName,
        })
      : t('plantTags.scan.lastCare', {
          task: taskLabel.toLocaleLowerCase(),
          when: formatRelativeDay(care.completedAt),
          name: care.completedByName,
        });
  };

  const remaining = (view?.tasks ?? []).filter((task) => !doneIds.has(task.taskId));

  return (
    <PublicShell width="article" plainHeader>
      {status === 'loading' && (
        <div className="flex min-h-[40vh] items-center justify-center" role="status">
          <LoadingSpinner size="lg" />
          <span className="sr-only">{t('plantTags.scan.loading')}</span>
        </div>
      )}

      {status === 'inactive' && (
        <div className="mt-8">
          <Alert variant="info" title={t('plantTags.scan.inactiveTitle')}>
            {t('plantTags.scan.inactiveBody')}
          </Alert>
        </div>
      )}

      {status === 'error' && (
        <div className="mt-8">
          <Alert variant="error" title={t('plantTags.scan.errorTitle')}>
            {t('plantTags.scan.errorBody')}
          </Alert>
        </div>
      )}

      {status === 'locked' && (
        <div className="mt-8">
          <Alert variant="warning" title={t('plantTags.scan.lockedTitle')}>
            {lockedUntil
              ? t('plantTags.scan.lockedBodyUntil', { when: formatRelativeDay(lockedUntil) })
              : t('plantTags.scan.lockedBody')}
          </Alert>
        </div>
      )}

      {status === 'pin' && (
        <form
          className="mt-8 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            load(pinDraft);
          }}
        >
          <h1 className="font-serif text-2xl tracking-tight text-ink">
            {t('plantTags.scan.pinTitle')}
          </h1>
          <p className="text-base text-gray-600">{t('plantTags.scan.pinBody')}</p>
          <Input
            label={t('plantTags.scan.pinLabel')}
            value={pinDraft}
            onChange={(event) => setPinDraft(event.target.value.replace(/\D/g, '').slice(0, 4))}
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            error={pinWrong ? t('plantTags.scan.pinWrong') : undefined}
          />
          <Button type="submit" variant="primary" disabled={pinDraft.length !== 4}>
            {t('plantTags.scan.pinSubmit')}
          </Button>
        </form>
      )}

      {status === 'ready' && view && (
        <>
          <h1 className="font-serif text-3xl tracking-tight text-ink sm:text-4xl">
            {view.plantName}
          </h1>
          {view.species && <p className="mt-1 text-base italic text-gray-600">{view.species}</p>}

          {/* The line this whole feature exists to show. */}
          <p className="mt-4 text-base text-gray-900" data-testid="last-care">
            {view.history.status === 'unavailable'
              ? t('plantTags.scan.historyUnavailable')
              : view.history.lastWatered
                ? careLine(view.history.lastWatered, true)
                : view.history.lastCare
                  ? careLine(view.history.lastCare, false)
                  : t('plantTags.scan.noCareYet')}
          </p>

          {view.careNotes && (
            <section className="mt-6 rounded-xl border border-primary-100/80 bg-paper p-4">
              <h2 className="text-sm font-medium text-ink">{t('plantTags.scan.houseRules')}</h2>
              <p className="mt-1 whitespace-pre-line text-sm text-gray-700">{view.careNotes}</p>
            </section>
          )}

          <div className="mt-8 space-y-4" aria-live="polite">
            {thanks && (
              <Alert variant="success" title={t('plantTags.scan.thanksTitle', { name: thanks })}>
                {t('plantTags.scan.thanksBody')}
              </Alert>
            )}
            {completionFailed && (
              <Alert variant="error" title={t('plantTags.scan.completeFailedTitle')}>
                {t('plantTags.scan.completeFailedBody')}
              </Alert>
            )}

            {remaining.length === 0 ? (
              !thanks && <p className="text-base text-gray-700">{t('plantTags.scan.nothingDue')}</p>
            ) : (
              <>
                <Input
                  label={t('plantTags.scan.nameLabel')}
                  placeholder={t('plantTags.scan.namePlaceholder')}
                  helperText={t('plantTags.scan.nameHelp')}
                  value={name}
                  maxLength={40}
                  autoComplete="off"
                  onChange={(event) => {
                    setName(event.target.value);
                    if (event.target.value.trim()) setNameError(false);
                  }}
                  error={nameError ? t('plantTags.scan.nameRequired') : undefined}
                />
                <ul className="space-y-3">
                  {remaining.map((task) => {
                    const taskLabel = t(`tasks.types.${task.taskType}`, {
                      defaultValue: task.taskType,
                    });
                    return (
                      <li
                        key={task.taskId}
                        className="flex items-center justify-between gap-4 rounded-xl border border-primary-100/80 bg-white p-4 shadow-journal"
                      >
                        <div className="min-w-0">
                          <p className="font-medium text-gray-900">
                            {t('plantTags.scan.taskDue', {
                              task: taskLabel,
                              plant: view.plantName,
                            })}
                          </p>
                          <p
                            className={
                              'mt-0.5 text-sm ' +
                              (task.overdue ? 'text-amber-700' : 'text-gray-600')
                            }
                          >
                            {task.overdue
                              ? t('plantTags.scan.overdue')
                              : t('plantTags.scan.due', {
                                  when: formatRelativeDay(task.dueDate),
                                })}
                          </p>
                        </div>
                        <Button
                          variant="primary"
                          size="sm"
                          isLoading={pending === task.taskId}
                          onClick={() => void handleComplete(task)}
                        >
                          {t('plantTags.scan.done')}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>

          <p className="mt-10 text-sm text-gray-600">
            {t('plantTags.scan.footer')}{' '}
            <Link to="/" className="text-primary-700 underline hover:text-primary-800">
              Family Greenhouse
            </Link>
          </p>
        </>
      )}
    </PublicShell>
  );
}
