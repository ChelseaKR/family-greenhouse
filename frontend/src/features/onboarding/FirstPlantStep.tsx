import { useMemo, useState, type Ref } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { plantService } from '@/services/plantService';
import { suggestTaskTemplate, taskService } from '@/services/taskService';
import { track } from '@/services/analytics';
import { getErrorMessage } from '@/services/api';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';
import { EmptyPlants } from '@/components/illustrations/EmptyPlants';
import { toast } from '@/store/toastStore';
import type { FirstRunVariant } from './firstRunModel';

const makeFirstPlantSchema = (t: TFunction) =>
  z.object({
    name: z
      .string()
      .trim()
      .min(1, t('firstRun.plant.nameRequired'))
      .max(100, t('firstRun.plant.nameTooLong')),
    species: z.string().trim().max(100, t('firstRun.plant.speciesTooLong')).optional(),
  });

type FirstPlantFormData = z.infer<ReturnType<typeof makeFirstPlantSchema>>;

/**
 * The starting points offered when the species matches no curated bundle.
 *
 * These are NOT claims about a species — we don't know the species, that is
 * the whole situation. They are three watering rhythms the user picks between
 * and can change from the plant's page, which is why the copy says "a
 * starting point" and why the chosen value is visible in the form before it
 * is ever submitted. Without this, a first run whose species we don't
 * recognise (or that has no species at all) finished with a plant and zero
 * tasks: no reminder would ever fire and the dashboard had nothing to show.
 */
const WATER_STARTING_POINTS = [
  { days: 4, key: 'firstRun.plant.scheduleStartThirsty' },
  { days: 7, key: 'firstRun.plant.scheduleStartAverage' },
  { days: 21, key: 'firstRun.plant.scheduleStartDrought' },
] as const;

/** The middle option. A default the user is shown, not a fact we assert. */
const DEFAULT_WATER_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface FirstPlantStepProps {
  headingId: string;
  headingRef: Ref<HTMLHeadingElement>;
  householdId: string;
  /**
   * Whose first run this is. The form, the endpoint and the schedule
   * behaviour are identical; only the framing changes. Telling someone who
   * just joined a household of twelve plants to "add your first plant" is
   * false, and it was the reason joiners were skipped past this step
   * entirely rather than spoken to differently.
   */
  variant: FirstRunVariant;
  /** Called once the plant genuinely exists server-side. */
  onAdded: () => void;
  onSkip: () => void;
  /** Hand off to the full Add Plant page (photos, spaces, identification). */
  onWantsFullForm: () => void;
}

/**
 * Step one: get one real plant into the household.
 *
 * This is the activation moment, so it happens HERE rather than by punting
 * the user at `/plants/new` and hoping they come back — the form is the
 * smallest honest subset of AddPlantPage (name, optional species) and posts
 * to the same endpoint. Anyone who wants photos, spaces or photo-ID gets a
 * one-click handoff to the real page instead of a second-rate copy of it.
 *
 * For a `joiner` the same step is the moment they put something of their own
 * into a shared household, which is the point at which they stop being a
 * spectator of someone else's plants.
 */
export function FirstPlantStep({
  headingId,
  headingRef,
  householdId,
  variant,
  onAdded,
  onSkip,
  onWantsFullForm,
}: FirstPlantStepProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [applySchedule, setApplySchedule] = useState(true);
  // Only consulted when no curated bundle matched. `null` is the user
  // explicitly declining a reminder, which stays a real option.
  const [waterEveryDays, setWaterEveryDays] = useState<number | null>(DEFAULT_WATER_DAYS);
  const schema = useMemo(() => makeFirstPlantSchema(t), [t]);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FirstPlantFormData>({ resolver: zodResolver(schema) });

  const speciesValue = watch('species') ?? '';

  // Same query key AddPlantPage uses, so this read is shared rather than
  // duplicated once the user reaches the full form.
  const templatesQuery = useQuery({
    queryKey: ['task-templates'],
    queryFn: taskService.listTemplates,
    staleTime: 60 * 60 * 1000,
  });

  const matchedTemplate = useMemo(
    () =>
      templatesQuery.data ? suggestTaskTemplate(templatesQuery.data, speciesValue) : undefined,
    [templatesQuery.data, speciesValue]
  );

  const mutation = useMutation({
    mutationFn: async (data: FirstPlantFormData) => {
      const species = data.species?.trim();
      const plant = await plantService.createPlant({
        name: data.name.trim(),
        ...(species ? { species } : {}),
      });

      // Best-effort, and never invented. A recognised species gets the
      // curated bundle the user was shown by name; an unrecognised one gets
      // the watering rhythm the user picked, which is their statement rather
      // than ours. What it must never do again is finish silently with no
      // schedule at all — that left the household with a plant, no reminder
      // and nothing on the dashboard, with the product's whole loop
      // unstarted (#477).
      let scheduled = false;
      let scheduleFailed = false;
      let startedEveryDays: number | null = null;
      if (applySchedule && matchedTemplate) {
        try {
          await taskService.applyTemplate(plant.id, matchedTemplate.id);
          scheduled = true;
        } catch {
          scheduleFailed = true;
        }
      } else if (!matchedTemplate && waterEveryDays !== null) {
        try {
          await taskService.createTask({
            plantId: plant.id,
            type: 'water',
            frequency: waterEveryDays,
            // One interval out, not "now". `createTask` defaults nextDue to
            // the instant of creation, so a plant added this afternoon would
            // otherwise be reported as due today and overdue by morning —
            // the first email this household ever gets (#346).
            nextDue: new Date(Date.now() + waterEveryDays * MS_PER_DAY).toISOString(),
          });
          scheduled = true;
          startedEveryDays = waterEveryDays;
        } catch {
          scheduleFailed = true;
        }
      }
      return { plant, scheduled, scheduleFailed, startedEveryDays };
    },
    onSuccess: ({ plant, scheduled, scheduleFailed, startedEveryDays }) => {
      // Mirrors AddPlantPage's event so the activation funnel counts a
      // first-run plant and a plant added the long way as the same thing.
      track('plant_added', { ordinal: 'first' });
      queryClient.invalidateQueries({ queryKey: ['plants', householdId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', householdId] });
      toast.success(
        startedEveryDays !== null
          ? t('firstRun.plant.createdWithStartingPoint', {
              name: plant.name,
              days: startedEveryDays,
            })
          : scheduled
            ? t('firstRun.plant.createdWithSchedule', { name: plant.name })
            : t('firstRun.plant.created', { name: plant.name })
      );
      if (scheduleFailed) toast.info(t('firstRun.plant.scheduleFailed', { name: plant.name }));
      onAdded();
    },
    onError: (err) => setError(getErrorMessage(err)),
  });

  return (
    <div>
      <div className="text-center">
        <EmptyPlants className="mx-auto h-28 w-auto" />
        <h1
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="mt-4 font-serif text-3xl tracking-tight text-ink focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
        >
          {variant === 'joiner' ? t('firstRun.plant.joinedTitle') : t('firstRun.plant.title')}
        </h1>
        <p className="mt-3 text-base leading-relaxed text-gray-700">
          {variant === 'joiner'
            ? t('firstRun.plant.joinedDescription')
            : t('firstRun.plant.description')}
        </p>
      </div>

      {error && (
        <Alert variant="error" className="mt-6">
          {error}
        </Alert>
      )}

      <form
        onSubmit={handleSubmit((data) => {
          setError(null);
          mutation.mutate(data);
        })}
        className="mt-6 space-y-5"
        noValidate
      >
        <Input
          label={t('firstRun.plant.nameLabel')}
          placeholder={t('firstRun.plant.namePlaceholder')}
          autoComplete="off"
          required
          error={errors.name?.message}
          helperText={t('firstRun.plant.nameHelp')}
          {...register('name')}
        />

        <Input
          label={t('firstRun.plant.speciesLabel')}
          placeholder={t('firstRun.plant.speciesPlaceholder')}
          autoComplete="off"
          error={errors.species?.message}
          helperText={t('firstRun.plant.speciesHelp')}
          {...register('species')}
        />

        <ScheduleNotice
          hasSpecies={speciesValue.trim().length > 0}
          isPending={templatesQuery.isPending}
          isError={templatesQuery.isError}
          templateName={matchedTemplate?.name ?? null}
          templateDescription={matchedTemplate?.description ?? null}
          applySchedule={applySchedule}
          onToggleSchedule={setApplySchedule}
          waterEveryDays={waterEveryDays}
          onPickWaterEvery={setWaterEveryDays}
        />

        <div className="flex flex-col gap-3 sm:flex-row-reverse sm:items-center sm:justify-start">
          <Button type="submit" size="lg" isLoading={mutation.isPending} className="sm:min-w-44">
            {t('firstRun.plant.submit')}
          </Button>
          <Button type="button" variant="secondary" onClick={onSkip}>
            {t('firstRun.skip')}
          </Button>
        </div>
      </form>

      <p className="mt-5 text-center text-sm text-gray-600">
        <button
          type="button"
          onClick={onWantsFullForm}
          className="min-h-touch font-medium text-primary-700 underline underline-offset-2 hover:text-primary-800 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500"
        >
          {t('firstRun.plant.fullForm')}
        </button>
      </p>
    </div>
  );
}

interface ScheduleNoticeProps {
  hasSpecies: boolean;
  isPending: boolean;
  isError: boolean;
  templateName: string | null;
  templateDescription: string | null;
  applySchedule: boolean;
  onToggleSchedule: (next: boolean) => void;
  /** Chosen fallback cadence in days, or `null` for "no reminder". */
  waterEveryDays: number | null;
  onPickWaterEvery: (days: number | null) => void;
}

/**
 * What we will (and will not) schedule, stated honestly.
 *
 * The outcomes are deliberately distinct. "We have no schedule for that
 * species" is a real answer we can only give once the template catalog has
 * actually loaded; saying it while the read is in flight — or after it failed
 * — would publish an unread as a finding, which is the same defect class the
 * dashboard metrics were fixed for.
 *
 * What changed with #477: three of those outcomes used to be dead ends. Each
 * one is honest about what we don't know AND then offers a starting point the
 * user chooses, so the first run can no longer finish having scheduled
 * nothing. The one case that still offers nothing is the in-flight read,
 * because it is not an outcome yet.
 */
function ScheduleNotice({
  hasSpecies,
  isPending,
  isError,
  templateName,
  templateDescription,
  applySchedule,
  onToggleSchedule,
  waterEveryDays,
  onPickWaterEvery,
}: ScheduleNoticeProps) {
  const { t } = useTranslation();

  if (!hasSpecies) {
    // No species is not a failed read — there is simply nothing to look up —
    // so this is stated plainly and the fallback is offered immediately.
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-600">{t('firstRun.plant.scheduleNoSpecies')}</p>
        <WaterStartingPoint value={waterEveryDays} onPick={onPickWaterEvery} />
      </div>
    );
  }

  if (isPending) {
    return (
      <p className="text-sm text-gray-600" aria-live="polite">
        {t('firstRun.plant.scheduleChecking')}
      </p>
    );
  }

  if (isError) {
    return (
      <div className="space-y-3" aria-live="polite">
        <p className="text-sm text-gray-600">{t('firstRun.plant.scheduleCheckFailed')}</p>
        {/* A failed catalog read says nothing about how thirsty the plant is,
            so the user's own answer is still available and still true. */}
        <WaterStartingPoint value={waterEveryDays} onPick={onPickWaterEvery} />
      </div>
    );
  }

  if (!templateName) {
    return (
      <div className="space-y-3" aria-live="polite">
        <p className="text-sm text-gray-600">{t('firstRun.plant.scheduleUnknown')}</p>
        <WaterStartingPoint value={waterEveryDays} onPick={onPickWaterEvery} />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-primary-200/70 bg-primary-50/70 p-4">
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={applySchedule}
          onChange={(event) => onToggleSchedule(event.target.checked)}
          className="mt-1 h-4 w-4 shrink-0 rounded border-primary-300 text-primary-700 focus:ring-primary-500"
        />
        <span className="text-sm text-primary-900">
          <span className="font-medium">
            {t('firstRun.plant.scheduleMatch', { name: templateName })}
          </span>{' '}
          <span className="text-gray-700">{templateDescription}</span>
        </span>
      </label>
    </div>
  );
}

interface WaterStartingPointProps {
  value: number | null;
  onPick: (days: number | null) => void;
}

/**
 * The fallback: a watering rhythm the user states, offered whenever we have
 * no curated bundle to apply.
 *
 * A radio group rather than buttons so the chosen value is announced as a
 * selection and the whole set carries one label — the first run is covered by
 * an axe suite and this is the only new interactive control in it.
 *
 * The middle option is pre-selected. That is a default the user reads before
 * submitting and can change or decline here, not a claim about the species:
 * the legend says so in words. The alternative — selecting nothing by
 * default — is what shipped, and it means the median first run ends with no
 * schedule at all.
 */
function WaterStartingPoint({ value, onPick }: WaterStartingPointProps) {
  const { t } = useTranslation();

  return (
    <fieldset className="rounded-lg border border-dew/70 bg-paper/60 p-4">
      <legend className="px-1 text-sm font-medium text-ink">
        {t('firstRun.plant.scheduleStartLegend')}
      </legend>
      <p className="text-xs text-gray-600">{t('firstRun.plant.scheduleStartHint')}</p>
      <div className="mt-3 space-y-2">
        {WATER_STARTING_POINTS.map(({ days, key }) => (
          <label key={days} className="flex min-h-touch items-center gap-3 text-sm text-gray-800">
            <input
              type="radio"
              name="water-starting-point"
              checked={value === days}
              onChange={() => onPick(days)}
              className="h-4 w-4 shrink-0 border-primary-300 text-primary-700 focus:ring-primary-500"
            />
            <span>{t(key, { days })}</span>
          </label>
        ))}
        <label className="flex min-h-touch items-center gap-3 text-sm text-gray-800">
          <input
            type="radio"
            name="water-starting-point"
            checked={value === null}
            onChange={() => onPick(null)}
            className="h-4 w-4 shrink-0 border-primary-300 text-primary-700 focus:ring-primary-500"
          />
          <span>{t('firstRun.plant.scheduleStartNone')}</span>
        </label>
      </div>
    </fieldset>
  );
}
