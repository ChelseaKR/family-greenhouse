import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PublicShell } from '@/components/PublicShell';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useMetaTags } from '@/hooks/useMetaTags';
import {
  sitterService,
  SitterLinkInactiveError,
  type SitterBrief,
  type SitterBriefPlant,
} from '@/services/sitterService';
import { formatDate } from '@/i18n/format';
import { MapPinIcon, PrinterIcon } from '@heroicons/react/24/outline';

/**
 * The handoff brief: the household plant by plant, for the person covering
 * them. Public and account-free like the task list — the token in the URL is
 * the only credential.
 *
 * Everything on this page is the household's OWN record: the space, the
 * placement note, their care words, the plant's latest photo, and the tasks
 * due inside the window. Two absences are rendered as absences on purpose:
 *
 *   - A plant with no care note says so. It never gets generic advice, because
 *     a sitter cannot tell generic advice from the household's own instruction,
 *     and following the wrong one is how a plant dies.
 *   - A plant the curated pet-toxicity table does not know shows NO verdict.
 *     Silence is honest; a green "pet-safe" badge nobody verified is not.
 *
 * The page is designed to be printed and left on a counter: `print:` variants
 * drop the buttons and the site chrome, and keep each plant on one page.
 */
const KNOWN_TASK_TYPES = ['water', 'fertilize', 'prune', 'repot'] as const;

function PlantCard({ plant }: { plant: SitterBriefPlant }) {
  const { t } = useTranslation();
  const place = [plant.spaceName, plant.placementNote].filter(Boolean).join(' · ');
  // Custom task types are free text the household typed — show them as-is
  // rather than mapping them to a phrase they did not write.
  const taskLabel = (taskType: string): string =>
    (KNOWN_TASK_TYPES as readonly string[]).includes(taskType)
      ? t(`sitterBrief.task.${taskType}`)
      : taskType;

  return (
    <li className="break-inside-avoid rounded-xl border border-primary-100/80 bg-white p-5 shadow-journal print:border-gray-300 print:shadow-none">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-serif text-xl text-ink">{plant.name}</h2>
          <p className="mt-1 flex items-start gap-1 text-sm text-primary-800">
            <MapPinIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{place || t('sitterBrief.noPlace')}</span>
          </p>
        </div>
        {plant.photoUrl && (
          <img
            src={plant.photoUrl}
            alt={plant.name}
            className="h-20 w-20 shrink-0 rounded-lg object-cover"
          />
        )}
      </div>

      <div className="mt-4">
        <h3 className="text-xs font-medium uppercase tracking-wide text-gray-600">
          {plant.careNoteSource === 'rule'
            ? t('sitterBrief.houseRule')
            : t('sitterBrief.householdNote')}
        </h3>
        {plant.careNote ? (
          <p className="mt-1 text-sm text-ink">{plant.careNote}</p>
        ) : (
          // An absence, stated. Never a generated substitute.
          <p className="mt-1 text-sm italic text-gray-600">{t('sitterBrief.noCareNote')}</p>
        )}
      </div>

      {/* Only from the curated, hand-verified table. No match → nothing here:
          no verdict is honest, a made-up all-clear is not. */}
      {plant.petSafety && (
        <div
          className={
            'mt-4 rounded-lg p-3 text-sm ' +
            (plant.petSafety.cats === 'toxic' || plant.petSafety.dogs === 'toxic'
              ? 'bg-amber-50 text-amber-900 ring-1 ring-amber-200'
              : 'bg-primary-50 text-primary-900 ring-1 ring-primary-100')
          }
        >
          <p className="font-medium">
            {plant.petSafety.cats === 'toxic' || plant.petSafety.dogs === 'toxic'
              ? t('sitterBrief.petToxic', {
                  cats: t(`sitterBrief.verdict.${plant.petSafety.cats}`),
                  dogs: t(`sitterBrief.verdict.${plant.petSafety.dogs}`),
                })
              : t('sitterBrief.petSafe')}
          </p>
          <p className="mt-1">{plant.petSafety.note}</p>
          <p className="mt-1 text-xs">
            {t('sitterBrief.petSource', {
              matched: plant.petSafety.commonName,
              scientific: plant.petSafety.scientificName,
            })}
          </p>
        </div>
      )}

      <div className="mt-4">
        <h3 className="text-xs font-medium uppercase tracking-wide text-gray-600">
          {t('sitterBrief.whileYoureHere')}
        </h3>
        {plant.tasks.length === 0 ? (
          <p className="mt-1 text-sm text-gray-600">{t('sitterBrief.nothingDue')}</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {plant.tasks.map((task) => (
              <li key={task.taskId} className="text-sm text-ink">
                {taskLabel(task.taskType)} —{' '}
                <span className={task.overdue ? 'text-amber-700' : 'text-gray-600'}>
                  {task.overdue
                    ? t('sitterBrief.overdueSince', { date: formatDate(task.dueDate) })
                    : t('sitterBrief.due', { date: formatDate(task.dueDate) })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

export function SitBriefPage() {
  const { token = '' } = useParams<{ token: string }>();
  const { t } = useTranslation();

  useMetaTags({
    title: t('sitterBrief.metaTitle'),
    description: t('sitterBrief.metaDescription'),
  });

  const [brief, setBrief] = useState<SitterBrief | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'inactive' | 'error'>('loading');

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    sitterService
      .getBrief(token, controller.signal)
      .then((data) => {
        setBrief(data);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // A failed read is an error, never an empty brief: "no plants" and
        // "we could not load the plants" must not look the same to a sitter.
        setStatus(err instanceof SitterLinkInactiveError ? 'inactive' : 'error');
      });
    return () => controller.abort();
  }, [token]);

  return (
    <PublicShell width="article" plainHeader>
      {status === 'loading' && (
        <div className="flex min-h-[40vh] items-center justify-center" role="status">
          <LoadingSpinner size="lg" />
          <span className="sr-only">{t('sitterBrief.loading')}</span>
        </div>
      )}

      {status === 'inactive' && (
        <div className="mt-8">
          <Alert variant="info" title={t('sitterBrief.unavailableTitle')}>
            {t('sitterBrief.unavailableBody')}
          </Alert>
        </div>
      )}

      {status === 'error' && (
        <div className="mt-8">
          <Alert variant="error" title={t('sitterBrief.errorTitle')}>
            {t('sitterBrief.errorBody')}
          </Alert>
        </div>
      )}

      {status === 'ready' && brief && (
        <>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="font-serif text-3xl tracking-tight text-ink sm:text-4xl">
                {brief.label
                  ? t('sitterBrief.titleLabelled', { label: brief.label })
                  : t('sitterBrief.title')}
              </h1>
              <p className="mt-2 text-sm text-gray-600">
                {t('sitterBrief.window', {
                  start: formatDate(brief.startsAt),
                  end: formatDate(brief.expiresAt),
                })}
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="print:hidden"
              onClick={() => window.print()}
              leftIcon={<PrinterIcon className="h-4 w-4" aria-hidden="true" />}
            >
              {t('sitterBrief.print')}
            </Button>
          </div>

          <p className="mt-3 text-base text-gray-600">{t('sitterBrief.intro')}</p>

          {brief.plants.length === 0 ? (
            <Alert variant="info" className="mt-8">
              {t('sitterBrief.noPlants')}
            </Alert>
          ) : (
            <ul className="mt-8 space-y-4">
              {brief.plants.map((plant) => (
                <PlantCard key={plant.plantId} plant={plant} />
              ))}
            </ul>
          )}

          <p className="mt-10 text-sm text-gray-600 print:hidden">
            <Link
              to={`/sit/${token}`}
              className="text-primary-700 underline hover:text-primary-800"
            >
              {t('sitterBrief.backToList')}
            </Link>
          </p>
        </>
      )}
    </PublicShell>
  );
}
