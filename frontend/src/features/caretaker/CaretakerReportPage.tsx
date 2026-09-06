import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { PrinterIcon } from '@heroicons/react/24/outline';
import { useActiveHousehold } from '@/hooks/useActiveHousehold';
import { caretakerSeatsService } from '@/services/caretakerSeatsService';
import { Card, CardHeader } from '@/components/Card';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { getErrorMessage } from '@/services/api';
import { formatDate, formatTime } from '@/i18n/format';

/**
 * The proof-of-visit report: the artefact a household hands to whoever is
 * paying a caretaker.
 *
 * The one thing this page must never do is render an empty report when the
 * read failed. "Nobody visited" and "we could not read the records" look
 * identical on screen and mean opposite things to the person being handed the
 * page, so the query's error state is bound explicitly and shown instead of
 * the report (ADR 0010, and the ratchet in scripts/check-settled-read-states).
 *
 * Per-visit detail can also be incomplete by design — a visit record caps how
 * many lines it stores while keeping exact counts — so each visit says how
 * many entries are counted but not listed rather than presenting the short
 * list as the whole story.
 */
function todayValue(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

export function CaretakerReportPage() {
  const { t } = useTranslation();
  const { householdId } = useActiveHousehold();
  const [from, setFrom] = useState(() => todayValue(-30));
  const [to, setTo] = useState(() => todayValue());
  const [range, setRange] = useState(() => ({ from: todayValue(-30), to: todayValue() }));

  const reportQuery = useQuery({
    queryKey: ['caretaker-report', householdId, range.from, range.to],
    queryFn: () => caretakerSeatsService.getReport(householdId!, range.from, range.to),
    enabled: Boolean(householdId),
  });
  const { data: report, isLoading, isError, error } = reportQuery;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={t('caretaker.report.title')}
          description={t('caretaker.report.description')}
        />
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setRange({ from, to });
          }}
        >
          <Input
            label={t('caretaker.report.fromLabel')}
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <Input
            label={t('caretaker.report.toLabel')}
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          <Button type="submit">{t('caretaker.report.apply')}</Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => window.print()}
            leftIcon={<PrinterIcon className="h-4 w-4" aria-hidden="true" />}
          >
            {t('caretaker.report.print')}
          </Button>
        </form>
      </Card>

      {isLoading && (
        <div className="flex min-h-[30vh] items-center justify-center" role="status">
          <LoadingSpinner size="lg" />
          <span className="sr-only">{t('caretaker.report.loading')}</span>
        </div>
      )}

      {isError && (
        // NOT an empty report. The difference between "no visits" and "we
        // could not look" is the whole point of this page.
        <Alert variant="error" title={t('caretaker.report.loadFailedTitle')}>
          {t('caretaker.report.loadFailedBody')} {getErrorMessage(error)}
        </Alert>
      )}

      {report && (
        <>
          <Card>
            <p className="text-sm text-gray-600">
              {t('caretaker.report.range', {
                from: formatDate(report.from),
                to: formatDate(report.to),
              })}{' '}
              · {t('caretaker.report.generatedAt', { date: formatDate(report.generatedAt) })}
            </p>
            <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
              {(
                [
                  ['totalsVisits', report.totals.visits],
                  ['totalsTasks', report.totals.tasksCompleted],
                  ['totalsPhotos', report.totals.photos],
                  ['totalsNotes', report.totals.notes],
                  ['totalsCaretakers', report.totals.caretakers],
                ] as const
              ).map(([key, value]) => (
                <div key={key}>
                  <dt className="text-xs text-gray-600">{t(`caretaker.report.${key}`)}</dt>
                  <dd className="font-serif text-2xl text-ink">{value}</dd>
                </div>
              ))}
            </dl>
          </Card>

          {report.byCaretaker.length > 0 && (
            <Card>
              <h2 className="text-base font-medium text-gray-900">
                {t('caretaker.report.byCaretakerHeading')}
              </h2>
              <ul className="mt-3 divide-y divide-primary-100/60">
                {report.byCaretaker.map((row) => (
                  <li key={row.caretakerId} className="py-2">
                    <p className="text-sm font-medium text-gray-900">{row.caretakerName}</p>
                    <p className="text-xs text-gray-600">
                      {t('caretaker.report.byCaretakerRange', {
                        first: formatDate(row.firstVisitAt),
                        last: formatDate(row.lastVisitAt),
                      })}{' '}
                      · {t('caretaker.report.totalsVisits')}: {row.visits} ·{' '}
                      {t('caretaker.report.totalsTasks')}: {row.tasksCompleted} ·{' '}
                      {t('caretaker.report.totalsPhotos')}: {row.photos} ·{' '}
                      {t('caretaker.report.totalsNotes')}: {row.notes}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <h2 className="text-base font-medium text-gray-900">
              {t('caretaker.report.visitsHeading')}
            </h2>
            <p className="mt-1 text-xs text-gray-600">{t('caretaker.report.arrivalNote')}</p>
            {report.visits.length === 0 ? (
              <p className="mt-3 text-sm text-gray-600">{t('caretaker.report.empty')}</p>
            ) : (
              <ol className="mt-3 space-y-6">
                {report.visits.map((visit) => (
                  <li key={visit.id}>
                    <h3 className="text-sm font-medium text-gray-900">
                      {t('caretaker.report.visitHeading', {
                        name: visit.caretakerName,
                        time: `${formatDate(visit.startedAt)} ${formatTime(visit.startedAt)}`,
                      })}
                    </h3>

                    {visit.tasksCompleted.length > 0 && (
                      <>
                        <p className="mt-2 text-xs font-medium uppercase tracking-wide text-gray-600">
                          {t('caretaker.report.tasksHeading')}
                        </p>
                        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-gray-700">
                          {visit.tasksCompleted.map((entry) => (
                            <li key={`${entry.taskId}-${entry.at}`}>
                              {t('caretaker.report.taskAt', {
                                task: entry.taskType,
                                plant: entry.plantName,
                                time: formatTime(entry.at),
                              })}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}

                    {visit.photos.length > 0 && (
                      <>
                        <p className="mt-2 text-xs font-medium uppercase tracking-wide text-gray-600">
                          {t('caretaker.report.photosHeading')}
                        </p>
                        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-gray-700">
                          {visit.photos.map((entry) => (
                            <li key={entry.photoId}>
                              {t('caretaker.report.photoAt', {
                                plant: entry.plantName,
                                time: formatTime(entry.at),
                              })}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}

                    {visit.notes.length > 0 && (
                      <>
                        <p className="mt-2 text-xs font-medium uppercase tracking-wide text-gray-600">
                          {t('caretaker.report.notesHeading')}
                        </p>
                        <ul className="mt-1 space-y-0.5 text-sm text-gray-700">
                          {visit.notes.map((entry) => (
                            <li key={entry.at}>
                              {t('caretaker.report.noteAt', {
                                time: formatTime(entry.at),
                                text: entry.text,
                              })}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}

                    {visit.detailTruncated && (
                      <p className="mt-2 text-xs text-amber-800">
                        {t('caretaker.report.truncated', {
                          tasks: visit.omitted.tasks,
                          photos: visit.omitted.photos,
                          notes: visit.omitted.notes,
                        })}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
