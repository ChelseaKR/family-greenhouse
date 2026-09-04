import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { plantService, type Plant } from '@/services/plantService';
import { Alert } from '@/components/Alert';

/**
 * The pre-trip gap prompt (ADR 0015).
 *
 * The handoff brief is only as good as what the household wrote down, and
 * `notes` / `placementNote` are optional and frequently empty. A brief that
 * says "no note" for twenty plants is worse than nothing — so before the trip
 * we count the gaps, name them, and link straight to the plant that has one.
 * This is the mitigation for the brief's honest risk, and it is a good
 * pre-trip flow in its own right: it is the moment someone actually cares
 * enough to write the note down.
 *
 * Deliberately NOT rendered as a count when we could not look: a failed read
 * says so, because "0 plants are missing notes" and "we could not check" are
 * different sentences and only one of them is reassuring.
 */
const MAX_LISTED = 5;

/** A plant's care words: a structured care rule if this deployment has them,
 *  else free-text notes. Kept defensive — `careRule` is a newer field. */
function hasCareNote(plant: Plant & { careRule?: string | null }): boolean {
  return Boolean(plant.careRule?.trim() || plant.notes?.trim());
}

function hasPlacement(plant: Plant): boolean {
  return Boolean(plant.placementNote?.trim());
}

function GapList({ plants, heading }: { plants: Plant[]; heading: string }) {
  const { t } = useTranslation();
  return (
    <div className="mt-3">
      <p className="text-sm font-medium text-gray-900">{heading}</p>
      <ul className="mt-1 flex flex-wrap gap-x-2 gap-y-1">
        {plants.slice(0, MAX_LISTED).map((plant) => (
          <li key={plant.id} className="text-sm">
            <Link
              to={`/plants/${plant.id}`}
              className="text-primary-700 underline hover:text-primary-800"
            >
              {plant.name}
            </Link>
          </li>
        ))}
        {plants.length > MAX_LISTED && (
          <li className="text-sm text-gray-600">
            {t('household.sitterGaps.andMore', { count: plants.length - MAX_LISTED })}
          </li>
        )}
      </ul>
    </div>
  );
}

export function SitterGapPrompt({ householdId }: { householdId: string }) {
  const { t } = useTranslation();
  const {
    data: plants,
    isError,
    isPending,
  } = useQuery({
    queryKey: ['plants', householdId],
    queryFn: () => plantService.getPlants('active'),
  });

  if (isError) {
    // A failed read is not "nothing is missing".
    return (
      <Alert variant="warning" className="mt-4">
        {t('household.sitterGaps.checkFailed')}
      </Alert>
    );
  }
  if (isPending || !plants) return null;

  const missingCare = plants.filter((plant) => !hasCareNote(plant));
  const missingPlacement = plants.filter((plant) => !hasPlacement(plant));

  if (plants.length === 0) return null;
  if (missingCare.length === 0 && missingPlacement.length === 0) {
    return <p className="mt-4 text-sm text-gray-600">{t('household.sitterGaps.allCovered')}</p>;
  }

  return (
    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <p className="flex items-start gap-2 text-sm font-medium text-amber-900">
        <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{t('household.sitterGaps.heading')}</span>
      </p>
      {missingCare.length > 0 && (
        <GapList
          plants={missingCare}
          heading={t('household.sitterGaps.noCareNote', { count: missingCare.length })}
        />
      )}
      {missingPlacement.length > 0 && (
        <GapList
          plants={missingPlacement}
          heading={t('household.sitterGaps.noPlacement', { count: missingPlacement.length })}
        />
      )}
      <p className="mt-3 text-xs text-amber-900">{t('household.sitterGaps.help')}</p>
    </div>
  );
}
