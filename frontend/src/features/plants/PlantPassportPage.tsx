import { useId, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeftIcon,
  ExclamationTriangleIcon,
  PrinterIcon,
  QrCodeIcon,
} from '@heroicons/react/24/outline';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { useIsHouseholdAdmin } from '@/hooks/useActiveHouseholdRole';
import { getErrorMessage } from '@/services/api';
import { formatDate } from '@/i18n/format';
import { plantService, type PlantWithTasks } from '@/services/plantService';
import { petToxicityService, type ToxicityMatch } from '@/services/petToxicityService';
import { printPage } from '@/services/nativePrint';
import { QrCode } from '@/features/tags/QrCode';
import {
  PASSPORT_HISTORY_DAYS,
  PASSPORT_HISTORY_LIMIT,
  passportHistory,
  passportHouseRule,
  passportNotes,
  passportPetSafety,
  passportSchedule,
  type PassportHistory,
} from './plantPassport';

const KNOWN_TASK_TYPES = ['water', 'fertilize', 'prune', 'repot'] as const;

/**
 * The plant passport (#676): one printable page about one plant, for handing
 * it — or a cutting of it — to someone outside the household.
 *
 * It is a print document, so it lives outside the app Layout: no sidebar,
 * header or banner to hide from the printer, and the only controls on the
 * page sit in one `print:hidden` panel above the passport itself.
 *
 * What it will and will not print is decided in `./plantPassport.ts`, where
 * a test can reach it without rendering. In short: the house rule and never
 * the notes (the `resolveCareNote` rule); the plant's private notes only when
 * an admin ticks "include my notes" on this visit; initials for whoever did
 * the care unless full names are asked for; pet safety only from the curated
 * ASPCA-grounded table; nothing generated; and every absence stated as one.
 *
 * It reads nothing a member cannot already see on the plant page, so it is
 * free on every plan — there is no gate here for a client to enforce, and so
 * no LockedFeature and no price, in the browser or in the native shells.
 *
 * The QR code is opt-in. It is the existing 14-day cutting-share link, minted
 * only when the person printing asks for it, because minting creates a public
 * link and loading a page should not.
 */
export function PlantPassportPage() {
  const { t } = useTranslation();
  const { plantId } = useParams<{ plantId: string }>();
  const householdId = useActiveHouseholdId();
  const isAdmin = useIsHouseholdAdmin();
  const titleId = useId();
  const optionsId = useId();

  // Private-by-default choices, held for this visit only and never stored:
  // every visit to this page starts from initials and no notes.
  const [fullNames, setFullNames] = useState(false);
  const [includeNotes, setIncludeNotes] = useState(false);
  // Fixed at mount, so the history window cannot shift under a re-render.
  const [now] = useState(() => new Date());

  const plantQuery = useQuery({
    queryKey: ['plants', householdId, plantId],
    queryFn: () => plantService.getPlant(plantId!),
    enabled: !!plantId,
  });
  const plant = plantQuery.data;

  const historyQuery = useQuery({
    queryKey: ['plants', householdId, plantId, 'history'],
    queryFn: () => plantService.getPlantHistory(plantId!),
    enabled: !!plantId,
  });

  const petQuery = useQuery({
    queryKey: ['pet-toxicity', 'passport', plant?.species ?? null, plant?.name ?? null],
    queryFn: ({ signal }) =>
      passportPetSafety(plant!, (query) => petToxicityService.lookup(query, signal)),
    enabled: !!plant,
    staleTime: 60 * 60 * 1000,
    retry: false,
  });

  const shareMutation = useMutation({
    mutationFn: () => plantService.sharePlant(plantId!),
  });

  useDocumentTitle(
    plant ? t('plants.passport.documentTitle', { name: plant.name }) : t('plants.passport.eyebrow')
  );

  const backTo = plantId ? `/plants/${plantId}` : '/plants';
  const canIncludeNotes = isAdmin && Boolean(plant?.notes?.trim());
  const readsSettled = !historyQuery.isPending && !petQuery.isPending;

  return (
    <div className="min-h-screen bg-paper print:min-h-0 print:bg-white">
      <header className="border-b border-dew/60 bg-paper/95 pt-[env(safe-area-inset-top)] print:hidden">
        <div className="mx-auto flex max-w-3xl items-center px-4 py-3 sm:px-6">
          <Link
            to={backTo}
            className="inline-flex min-h-touch items-center text-sm text-gray-700 hover:text-gray-900"
          >
            <ArrowLeftIcon className="mr-1 h-4 w-4" aria-hidden="true" />
            {plant
              ? t('plants.passport.backToPlant', { name: plant.name })
              : t('plants.backToPlants')}
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6 print:max-w-none print:space-y-0 print:p-0">
        {plantQuery.isPending && (
          <div className="flex items-center justify-center gap-3 py-12" role="status">
            <LoadingSpinner size="lg" />
            <span className="sr-only">{t('plants.passport.loading')}</span>
          </div>
        )}

        {plantQuery.isError && (
          <Alert variant="error" title={t('plants.passport.loadFailedTitle')}>
            {getErrorMessage(plantQuery.error)}
          </Alert>
        )}

        {plant && (
          <>
            <section
              aria-labelledby={optionsId}
              className="space-y-4 rounded-xl border border-primary-100/80 bg-white p-5 shadow-journal print:hidden"
              data-testid="passport-controls"
            >
              <div>
                <h1 id={optionsId} className="font-serif text-2xl leading-tight text-ink">
                  {t('plants.passport.pageTitle', { name: plant.name })}
                </h1>
                <p className="mt-1 text-sm text-gray-700">{t('plants.passport.optionsIntro')}</p>
              </div>

              <fieldset className="space-y-3">
                <legend className="text-sm font-medium text-gray-900">
                  {t('plants.passport.optionsLegend')}
                </legend>
                <OptionCheckbox
                  checked={fullNames}
                  onChange={setFullNames}
                  label={t('plants.passport.fullNames')}
                  hint={t('plants.passport.fullNamesHint')}
                />
                {canIncludeNotes && (
                  <OptionCheckbox
                    checked={includeNotes}
                    onChange={setIncludeNotes}
                    label={t('plants.passport.includeNotes')}
                    hint={t('plants.passport.includeNotesHint')}
                  />
                )}
              </fieldset>

              <div className="space-y-2">
                {!shareMutation.data && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => shareMutation.mutate()}
                    isLoading={shareMutation.isPending}
                    leftIcon={<QrCodeIcon className="h-4 w-4" aria-hidden="true" />}
                  >
                    {t('plants.passport.qrAdd')}
                  </Button>
                )}
                <p className="text-sm text-gray-600">{t('plants.passport.qrHint')}</p>
                {shareMutation.isError && (
                  <Alert variant="error" title={t('plants.passport.qrFailedTitle')}>
                    {getErrorMessage(shareMutation.error)}
                  </Alert>
                )}
                {shareMutation.data && (
                  <p className="text-sm font-medium text-primary-800" role="status">
                    {t('plants.passport.qrAdded', {
                      date: formatDate(shareMutation.data.expiresAt),
                    })}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={(event) => void printPage(event.currentTarget)}
                  disabled={!readsSettled}
                  leftIcon={<PrinterIcon className="h-4 w-4" aria-hidden="true" />}
                >
                  {t('plants.passport.print')}
                </Button>
                {!readsSettled && (
                  <span className="text-sm text-gray-600" role="status">
                    {t('plants.passport.printWaiting')}
                  </span>
                )}
              </div>
            </section>

            <PassportSheet
              plant={plant}
              titleId={titleId}
              history={passportHistory(
                historyQuery.isError ? undefined : historyQuery.data,
                plant,
                { fullNames, now }
              )}
              historyPending={historyQuery.isPending}
              pet={petQuery}
              notes={passportNotes(plant, { includeNotes, isAdmin })}
              share={shareMutation.data ?? null}
              now={now}
            />
          </>
        )}
      </main>
    </div>
  );
}

/** A checkbox whose hint is its description, not part of its name. */
function OptionCheckbox({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint: string;
}) {
  const inputId = useId();
  const hintId = useId();
  return (
    <div className="flex items-start gap-3 text-sm">
      <input
        id={inputId}
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 accent-primary-700"
        checked={checked}
        aria-describedby={hintId}
        onChange={(event) => onChange(event.target.checked)}
      />
      <div>
        <label htmlFor={inputId} className="text-gray-900">
          {label}
        </label>
        <p id={hintId} className="text-gray-600">
          {hint}
        </p>
      </div>
    </div>
  );
}

interface PassportSheetProps {
  plant: PlantWithTasks;
  titleId: string;
  history: PassportHistory;
  historyPending: boolean;
  pet: {
    isPending: boolean;
    isError: boolean;
    data?: { match: ToxicityMatch; matchedOn: string } | null;
  };
  notes: string | null;
  share: { url: string; expiresAt: string } | null;
  now: Date;
}

/** The printed page itself: one plant, readable in black and white. */
function PassportSheet({
  plant,
  titleId,
  history,
  historyPending,
  pet,
  notes,
  share,
  now,
}: PassportSheetProps) {
  const { t } = useTranslation();
  const houseRule = passportHouseRule(plant);
  const schedule = passportSchedule(plant);
  const status = plant.status ?? 'active';
  const lineage = plant.lineage;
  const hasLineage = Boolean(lineage && (lineage.parent || lineage.children.length > 0));

  const taskLabel = (type: string, customType?: string | null): string =>
    customType ||
    ((KNOWN_TASK_TYPES as readonly string[]).includes(type) ? t(`tasks.types.${type}`) : type);

  const statusLabel: Record<string, string> = {
    died: t('plants.status.died'),
    gave_away: t('plants.status.gaveAway'),
    archived: t('plants.status.archived'),
  };

  return (
    <article
      aria-labelledby={titleId}
      className="space-y-6 rounded-xl border border-gray-300 bg-white p-6 text-ink print:rounded-none print:border-0 print:p-0 print:text-black"
      data-testid="plant-passport"
    >
      <header className="border-b-2 border-gray-800 pb-4">
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-700 print:text-black">
          {t('plants.passport.eyebrow')}
        </p>
        <h2
          id={titleId}
          className="mt-1 font-serif text-4xl leading-tight text-ink print:text-black"
        >
          {plant.name}
        </h2>
        <p className="mt-1 text-lg italic text-gray-800 print:text-black">
          {plant.species ?? t('plants.passport.speciesUnknown')}
        </p>
        {plant.species && plant.speciesSource && (
          <p className="mt-1 text-sm text-gray-700 print:text-black">
            {t(`plants.passport.speciesSource.${plant.speciesSource}`)}
          </p>
        )}
        <p className="mt-2 text-sm text-gray-800 print:text-black">
          {t('plants.passport.addedOn', { date: formatDate(plant.createdAt) })}
          {status !== 'active' && (
            <>
              {' · '}
              {t('plants.passport.statusLine', { status: statusLabel[status] })}
            </>
          )}
        </p>
      </header>

      <div className="grid gap-6 sm:grid-cols-2 print:grid-cols-2">
        <PassportSection heading={t('plants.passport.houseRuleHeading')}>
          {houseRule ? (
            <p className="font-serif text-lg leading-snug">{houseRule}</p>
          ) : (
            // Stated, never filled in (#599): "no rule was written" is a
            // different claim from an empty space, and nothing generated
            // stands in for the household's own words.
            <p className="text-sm italic text-gray-700 print:text-black">
              {t('plants.passport.noHouseRule')}
            </p>
          )}
        </PassportSection>

        <PassportSection heading={t('plants.passport.petsHeading')}>
          <PetSafetyBlock pet={pet} />
        </PassportSection>
      </div>

      <PassportSection heading={t('plants.passport.scheduleHeading')}>
        {status !== 'active' && schedule.length > 0 && (
          <p className="mb-2 text-sm text-gray-700 print:text-black">
            {t('plants.passport.schedulePaused')}
          </p>
        )}
        {schedule.length === 0 ? (
          <p className="text-sm italic text-gray-700 print:text-black">
            {t('plants.passport.noSchedule')}
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {schedule.map((item) => (
              <li key={item.id}>
                <span className="font-medium">{taskLabel(item.type, item.customType)}</span>
                {' — '}
                {t('tasks.seasonal.interval', { count: item.frequency })}
                {item.seasonal.length > 0 && (
                  <span className="block text-gray-700 print:text-black">
                    {t('plants.passport.bySeason', {
                      list: item.seasonal
                        .map((cadence) =>
                          t('plants.passport.seasonInterval', {
                            season: t(`tasks.seasonal.season.${cadence.season}`),
                            interval: t('tasks.seasonal.interval', { count: cadence.frequency }),
                          })
                        )
                        .join(' · '),
                    })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </PassportSection>

      <PassportSection heading={t('plants.passport.historyHeading')}>
        <CareHistoryBlock
          history={history}
          pending={historyPending}
          addedOn={plant.createdAt}
          taskLabel={taskLabel}
        />
      </PassportSection>

      <PassportSection heading={t('plants.passport.lineageHeading')}>
        {hasLineage && lineage ? (
          <dl className="space-y-2 text-sm">
            {lineage.parent && (
              <div>
                <dt className="font-medium">{t('plants.lineage.parentLabel')}</dt>
                <dd>{lineage.parent.name}</dd>
              </div>
            )}
            {lineage.children.length > 0 && (
              <div>
                <dt className="font-medium">
                  {t('plants.lineage.childrenLabel')} (
                  {t('plants.lineage.childrenCount', { count: lineage.children.length })})
                </dt>
                <dd>
                  <ul className="mt-1 space-y-0.5">
                    {lineage.children.map((child) => (
                      <li key={child.id}>
                        {child.name}
                        {' · '}
                        {formatDate(child.createdAt)}
                        {child.status !== 'active' && ` · ${statusLabel[child.status]}`}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="text-sm italic text-gray-700 print:text-black">
            {t('plants.passport.noLineage')}
          </p>
        )}
      </PassportSection>

      {notes && (
        <PassportSection heading={t('plants.passport.notesHeading')}>
          <p className="whitespace-pre-wrap text-sm" data-testid="passport-notes">
            {notes}
          </p>
        </PassportSection>
      )}

      {share && (
        <PassportSection heading={t('plants.passport.qrHeading')}>
          <figure className="flex items-center gap-4">
            <QrCode
              value={share.url}
              title={t('plants.passport.qrAlt', { name: plant.name })}
              size="7rem"
              className="h-28 w-28 shrink-0"
            />
            <figcaption className="min-w-0 space-y-1 text-sm">
              <p>{t('plants.passport.qrCaption')}</p>
              <p className="break-all font-mono text-xs">{share.url}</p>
              <p>{t('plants.passport.qrExpires', { date: formatDate(share.expiresAt) })}</p>
            </figcaption>
          </figure>
        </PassportSection>
      )}

      <footer className="border-t border-gray-400 pt-3 text-xs text-gray-700 print:text-black">
        <p>{t('plants.passport.footer')}</p>
        <p className="mt-1">{t('plants.passport.printedOn', { date: formatDate(now) })}</p>
      </footer>
    </article>
  );
}

function PassportSection({ heading, children }: { heading: string; children: React.ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="break-inside-avoid">
      <h3
        id={headingId}
        className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-700 print:text-black"
      >
        {heading}
      </h3>
      {children}
    </section>
  );
}

function PetSafetyBlock({ pet }: { pet: PassportSheetProps['pet'] }) {
  const { t } = useTranslation();
  if (pet.isPending) {
    return <p className="text-sm text-gray-700">{t('plants.passport.petChecking')}</p>;
  }
  if (pet.isError) {
    return (
      <p className="text-sm italic text-gray-700 print:text-black">
        {t('plants.passport.petUnavailable')}
      </p>
    );
  }
  if (!pet.data) {
    return (
      <p className="text-sm italic text-gray-700 print:text-black">
        {t('plants.passport.petNoMatch')}
      </p>
    );
  }
  const { match } = pet.data;
  const toxic = match.cats === 'toxic' || match.dogs === 'toxic';
  return (
    <div className="space-y-1 text-sm" data-testid="passport-pet-safety">
      <p className="flex items-start gap-1.5 font-medium">
        {toxic && (
          <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        <span>
          {toxic
            ? t('sitterBrief.petToxic', {
                cats: t(`sitterBrief.verdict.${match.cats}`),
                dogs: t(`sitterBrief.verdict.${match.dogs}`),
              })
            : t('sitterBrief.petSafe')}
        </span>
      </p>
      <p>{match.note}</p>
      <p className="text-xs text-gray-700 print:text-black">
        {t('sitterBrief.petSource', {
          matched: match.commonName,
          scientific: match.scientificName,
        })}
      </p>
    </div>
  );
}

function CareHistoryBlock({
  history,
  pending,
  addedOn,
  taskLabel,
}: {
  history: PassportHistory;
  pending: boolean;
  addedOn: string;
  taskLabel: (type: string) => string;
}) {
  const { t } = useTranslation();

  if (pending) {
    return <p className="text-sm text-gray-700">{t('plants.passport.historyLoading')}</p>;
  }
  // A failed read is never "no care" (ADR 0010): say the history is missing
  // from this sheet, and why.
  if (history.status === 'unavailable') {
    return (
      <p className="text-sm italic text-gray-700 print:text-black">
        {t('plants.passport.historyUnavailable')}
      </p>
    );
  }

  const days = PASSPORT_HISTORY_DAYS;
  let caption: string;
  if (history.entries.length === 0) {
    // An empty window is two different facts depending on the plant's age:
    // a plant added last week has not been cared for YET.
    caption = history.addedWithinWindow
      ? t('plants.passport.historyNoneSinceAdded', { date: formatDate(addedOn) })
      : t('plants.passport.historyNoneInWindow', { days });
  } else if (history.capped) {
    caption = t('plants.passport.historyCapped', { limit: PASSPORT_HISTORY_LIMIT, days });
  } else {
    caption = t('plants.passport.historyComplete', { count: history.entries.length, days });
  }

  if (history.entries.length === 0) {
    return (
      <div className="space-y-1 text-sm">
        <p>{caption}</p>
        {history.lastLoggedBeforeWindow && (
          <p>
            {t('plants.passport.historyLastBefore', {
              date: formatDate(history.lastLoggedBeforeWindow),
            })}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="text-sm">
      {/* The window statement IS the table's caption: it says what the rows
          are, including when they may not be all of them. */}
      <table className="w-full border-collapse text-left">
        <caption className="mb-2 text-left">{caption}</caption>
        <thead>
          <tr className="border-b border-gray-500">
            <th scope="col" className="py-1 pr-3 font-medium">
              {t('plants.passport.historyDate')}
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              {t('plants.passport.historyCare')}
            </th>
            <th scope="col" className="py-1 font-medium">
              {t('plants.passport.historyWho')}
            </th>
          </tr>
        </thead>
        <tbody>
          {history.entries.map((entry) => (
            <tr key={entry.id} className="border-b border-gray-200 print:border-gray-400">
              <td className="py-1 pr-3 whitespace-nowrap">{formatDate(entry.completedAt)}</td>
              <td className="py-1 pr-3">{taskLabel(entry.taskType)}</td>
              <td className="py-1">{entry.who ?? t('plants.passport.historySomeone')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
