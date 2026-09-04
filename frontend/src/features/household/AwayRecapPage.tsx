import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AxiosError } from 'axios';
import { CameraIcon, CheckCircleIcon, PencilSquareIcon } from '@heroicons/react/24/outline';
import { Alert } from '@/components/Alert';
import { Card, CardHeader } from '@/components/Card';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useActiveHousehold } from '@/hooks/useActiveHousehold';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { awayRecapService, type AwayRecap } from '@/services/awayRecapService';
import { formatDate } from '@/i18n/format';

/**
 * "What happened while you were away" — the Away Kit's return recap, visible
 * to every household member (not just the admin who minted the link).
 *
 * The whole point of this page is that its states are distinguishable. A
 * recap that renders empty is a claim — "your sitter did nothing" — and it
 * must only ever be made when the server actually said so. So:
 *
 *   loading     → a spinner
 *   402         → the locked state, with what the tier includes
 *   404         → "no sitter window has ended yet", which is a fact
 *   any error   → "we couldn't load it", explicitly NOT an empty recap
 *   0 of each   → "your sitter didn't record anything in this window"
 *   truncated   → the lists are a prefix and the page says so
 */
function statusOf(error: unknown): number | undefined {
  return error instanceof AxiosError ? error.response?.status : undefined;
}

function RecapBody({ recap }: { recap: AwayRecap }) {
  const { t } = useTranslation();
  const nothingRecorded =
    recap.counts.tasks === 0 && recap.counts.photos === 0 && recap.counts.notes === 0;

  return (
    <>
      <p className="text-sm text-gray-600">
        {t('awayRecap.window', {
          label: recap.link.label || t('awayRecap.untitledLink'),
          from: formatDate(recap.window.from),
          to: formatDate(recap.window.to),
        })}
      </p>

      {recap.truncated && (
        <Alert variant="warning" className="mt-4" title={t('awayRecap.truncatedTitle')}>
          {t('awayRecap.truncatedBody')}
        </Alert>
      )}

      {nothingRecorded ? (
        <Alert variant="info" className="mt-4" title={t('awayRecap.quietTitle')}>
          {t('awayRecap.quietBody')}
        </Alert>
      ) : (
        <dl className="mt-4 grid grid-cols-3 gap-3">
          <div className="rounded-lg bg-parchment p-3">
            <dt className="text-xs text-gray-600">{t('awayRecap.tasksLabel')}</dt>
            <dd className="text-lg font-medium text-ink">{recap.counts.tasks}</dd>
          </div>
          <div className="rounded-lg bg-parchment p-3">
            <dt className="text-xs text-gray-600">{t('awayRecap.photosLabel')}</dt>
            <dd className="text-lg font-medium text-ink">{recap.counts.photos}</dd>
          </div>
          <div className="rounded-lg bg-parchment p-3">
            <dt className="text-xs text-gray-600">{t('awayRecap.notesLabel')}</dt>
            <dd className="text-lg font-medium text-ink">{recap.counts.notes}</dd>
          </div>
        </dl>
      )}

      {recap.tasksCompleted.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold text-ink">{t('awayRecap.tasksHeading')}</h2>
          <ul className="mt-2 divide-y divide-primary-100/60 rounded-lg border border-primary-100/70">
            {recap.tasksCompleted.map((task) => (
              <li key={`${task.taskId}-${task.occurredAt}`} className="flex gap-3 px-4 py-3">
                <CheckCircleIcon
                  className="mt-0.5 h-4 w-4 shrink-0 text-primary-700"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="text-sm text-gray-900">
                    {t('awayRecap.taskLine', {
                      taskType: task.taskType,
                      plant: task.plantName || t('awayRecap.aPlant'),
                    })}
                  </p>
                  <p className="text-xs text-gray-600">
                    {t('awayRecap.taskBy', {
                      who: task.actorName,
                      when: formatDate(task.occurredAt),
                    })}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {recap.photos.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold text-ink">{t('awayRecap.photosHeading')}</h2>
          <ul className="mt-2 flex gap-3 overflow-x-auto pb-2">
            {recap.photos.map((photo) => (
              <li key={photo.photoId} className="shrink-0">
                <figure className="w-32">
                  {photo.imageUrl ? (
                    <img
                      src={photo.imageUrl}
                      alt={photo.caption ?? t('awayRecap.photoAlt')}
                      width={128}
                      height={128}
                      loading="lazy"
                      decoding="async"
                      className="h-32 w-32 rounded-md bg-parchment object-cover"
                    />
                  ) : (
                    // The event predates URL-carrying photo rows: say the
                    // image is unavailable rather than render a broken box.
                    <div className="flex h-32 w-32 items-center justify-center rounded-md bg-parchment text-xs text-gray-600">
                      <CameraIcon className="h-5 w-5" aria-hidden="true" />
                      <span className="sr-only">{t('awayRecap.photoUnavailable')}</span>
                    </div>
                  )}
                  <figcaption className="mt-1 text-xs text-gray-600">
                    {photo.plantName || t('awayRecap.aPlant')}
                  </figcaption>
                </figure>
              </li>
            ))}
          </ul>
        </section>
      )}

      {recap.notes.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold text-ink">{t('awayRecap.notesHeading')}</h2>
          <ul className="mt-2 space-y-2">
            {recap.notes.map((note) => (
              <li key={`${note.source}-${note.occurredAt}-${note.text}`} className="flex gap-2">
                <PencilSquareIcon
                  className="mt-0.5 h-4 w-4 shrink-0 text-primary-700"
                  aria-hidden="true"
                />
                <p className="text-sm text-gray-900">
                  {t('awayRecap.noteLine', {
                    plant: note.plantName || t('awayRecap.aPlant'),
                    text: note.text,
                  })}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export function AwayRecapPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('awayRecap.title'));
  const [params] = useSearchParams();
  const linkId = params.get('linkId') ?? undefined;
  const { householdQuery } = useActiveHousehold();

  const {
    data: recap,
    isLoading,
    isError,
    error,
  } = useQuery(
    householdQuery(
      (hh) => ['away-recap', hh, linkId ?? 'latest'],
      (hh) => awayRecapService.getRecap(hh, linkId),
      { retry: false }
    )
  );

  const status = isError ? statusOf(error) : undefined;

  return (
    <div className="mx-auto max-w-3xl">
      <Card>
        <CardHeader title={t('awayRecap.title')} description={t('awayRecap.description')} />

        {isLoading && (
          <div className="flex min-h-[30vh] items-center justify-center" role="status">
            <LoadingSpinner size="lg" />
            <span className="sr-only">{t('awayRecap.loading')}</span>
          </div>
        )}

        {isError && status === 402 && (
          <Alert variant="info" title={t('awayRecap.lockedTitle')}>
            {t('awayRecap.lockedBody')}
          </Alert>
        )}

        {isError && status === 404 && (
          <Alert variant="info" title={t('awayRecap.noneTitle')}>
            {t('awayRecap.noneBody')}
          </Alert>
        )}

        {isError && status !== 402 && status !== 404 && (
          // A failed read is never rendered as an empty recap: the household
          // would read "nothing happened while we were away" off a request
          // that never returned.
          <Alert variant="error" title={t('awayRecap.failedTitle')}>
            {t('awayRecap.failedBody')}
          </Alert>
        )}

        {!isLoading && !isError && recap && <RecapBody recap={recap} />}
      </Card>
    </div>
  );
}
