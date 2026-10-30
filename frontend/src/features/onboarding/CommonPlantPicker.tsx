import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { plantService } from '@/services/plantService';
import { taskService } from '@/services/taskService';
import { track } from '@/services/analytics';
import { trackGoogleConversion, type FirstPlantMethod } from '@/services/googleAnalytics';
import { getErrorMessage } from '@/services/api';
import { Alert } from '@/components/Alert';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { toast } from '@/store/toastStore';
import { COMMON_PLANTS, type CommonPlant } from './commonPlants';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface CommonPlantPickerProps {
  householdId: string;
  /** Called once the plant genuinely exists server-side. */
  onAdded: () => void;
  /** True while the typed form below is saving, so two adds cannot race. */
  disabled?: boolean;
  /** Lets the step disable its typed form while a tap is saving. */
  onPendingChange?: (pending: boolean) => void;
  /** Where the tap happened, for GA4 `first_plant_added`. */
  method?: Extract<FirstPlantMethod, 'common_plant' | 'dashboard_empty'>;
  /** The heading's level, so it nests under whatever surface hosts it. */
  headingAs?: 'h2' | 'h3';
  /**
   * The plant whose care guide the visitor signed up from
   * (./guidePlantHandoff). It is listed first, marked, and said so above the
   * list; it is still one tap the visitor makes or doesn't.
   */
  suggested?: CommonPlant;
}

/**
 * One tap, one plant: the first run's shortcut for someone who owns a pothos
 * and does not want to type "pothos".
 *
 * A tap saves the plant under its translated common name with the guide's
 * scientific name as its species, then starts ONE watering reminder at the
 * low end of the guide's range (see ./commonPlants). That is the whole
 * default. It never applies a template: the curated bundles are broad (a ZZ
 * plant would get the tropical bundle's weekly watering, against its own
 * guide's two to three weeks), and the guide is the better source.
 *
 * The reminder starts one interval out, never "now", for the reason the typed
 * form gives (#346): a plant added this afternoon must not be overdue by
 * morning. If the reminder fails, the plant is still saved and the household
 * is told, the same as the typed form.
 *
 * Accessibility: a labelled group of real buttons. Each button's name is the
 * plant's name; the shared hint (how often it will remind) is attached with
 * `aria-describedby`, so the grid is ten tab stops that each say what they do.
 */
export function CommonPlantPicker({
  householdId,
  onAdded,
  disabled = false,
  onPendingChange,
  method = 'common_plant',
  headingAs: Heading = 'h2',
  suggested,
}: CommonPlantPickerProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const headingId = useId();
  const hintId = useId();
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (pick: CommonPlant) => {
      const name = t(`firstRun.picker.plants.${pick.slug}`);
      const plant = await plantService.createPlant({ name, species: pick.scientificName });
      let scheduleFailed = false;
      try {
        await taskService.createTask({
          plantId: plant.id,
          type: 'water',
          frequency: pick.waterEveryDays,
          nextDue: new Date(Date.now() + pick.waterEveryDays * MS_PER_DAY).toISOString(),
        });
      } catch {
        scheduleFailed = true;
      }
      return { plant, pick, scheduleFailed };
    },
    onMutate: () => {
      setError(null);
      onPendingChange?.(true);
    },
    onSettled: () => onPendingChange?.(false),
    onSuccess: ({ plant, pick, scheduleFailed }) => {
      // The same activation events the typed form and AddPlantPage send, so
      // the funnel counts a tapped plant and a typed one as the same step.
      track('plant_added', { ordinal: 'first' });
      trackGoogleConversion({ name: 'household_activated' });
      trackGoogleConversion({
        name: 'first_plant_added',
        method: suggested?.slug === pick.slug ? 'guide_handoff' : method,
      });
      queryClient.invalidateQueries({ queryKey: ['plants', householdId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', householdId] });
      if (scheduleFailed) {
        toast.success(t('firstRun.plant.created', { name: plant.name }));
        toast.info(t('firstRun.plant.scheduleFailed', { name: plant.name }));
      } else {
        toast.success(
          t('firstRun.plant.createdWithStartingPoint', {
            name: plant.name,
            days: pick.waterEveryDays,
          })
        );
      }
      onAdded();
    },
    onError: (err) => setError(getErrorMessage(err)),
  });

  const busy = disabled || mutation.isPending;
  const picks = suggested
    ? [suggested, ...COMMON_PLANTS.filter((pick) => pick.slug !== suggested.slug)]
    : COMMON_PLANTS;

  return (
    <section aria-labelledby={headingId} className="mt-6">
      <Heading id={headingId} className="text-base font-semibold text-ink">
        {t('firstRun.picker.heading')}
      </Heading>
      <p id={hintId} className="mt-1 text-sm text-gray-600">
        {t('firstRun.picker.hint')}
      </p>
      {suggested && (
        <p data-testid="guide-plant-note" className="mt-2 text-sm text-ink">
          {t('firstRun.picker.fromGuide', {
            name: t(`firstRun.picker.plants.${suggested.slug}`),
            days: suggested.waterEveryDays,
          })}
        </p>
      )}

      {error && (
        <Alert variant="error" className="mt-3">
          {error}
        </Alert>
      )}

      <ul className="mt-3 grid grid-cols-2 gap-2 large-text:grid-cols-1">
        {picks.map((pick) => {
          const saving = mutation.isPending && mutation.variables?.slug === pick.slug;
          const isSuggested = suggested?.slug === pick.slug;
          return (
            <li
              key={pick.slug}
              className={clsx(isSuggested && 'col-span-2 large-text:col-span-1')}
              data-suggested={isSuggested || undefined}
            >
              <button
                type="button"
                onClick={() => mutation.mutate(pick)}
                disabled={busy}
                aria-describedby={hintId}
                aria-busy={saving || undefined}
                className={clsx(
                  'flex min-h-touch w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm font-medium transition-colors',
                  isSuggested
                    ? 'border-primary-500 bg-primary-50 text-ink hover:bg-primary-100'
                    : 'border-primary-200 bg-paper text-ink hover:border-primary-500 hover:bg-primary-50',
                  'focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2',
                  'disabled:cursor-not-allowed disabled:opacity-60'
                )}
              >
                <span>{t(`firstRun.picker.plants.${pick.slug}`)}</span>
                {saving && <LoadingSpinner size="sm" />}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="sr-only" role="status">
        {mutation.isPending ? t('firstRun.picker.saving') : ''}
      </p>
    </section>
  );
}
