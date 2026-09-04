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

      // Best-effort, and only ever from a curated bundle the user was shown
      // by name. A plant whose species we don't recognise gets NO invented
      // schedule — a made-up watering cadence is worse than none.
      let scheduled = false;
      let scheduleFailed = false;
      if (applySchedule && matchedTemplate) {
        try {
          await taskService.applyTemplate(plant.id, matchedTemplate.id);
          scheduled = true;
        } catch {
          scheduleFailed = true;
        }
      }
      return { plant, scheduled, scheduleFailed };
    },
    onSuccess: ({ plant, scheduled, scheduleFailed }) => {
      // Mirrors AddPlantPage's event so the activation funnel counts a
      // first-run plant and a plant added the long way as the same thing.
      track('plant_added', { ordinal: 'first' });
      queryClient.invalidateQueries({ queryKey: ['plants', householdId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', householdId] });
      toast.success(
        scheduled
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
}

/**
 * What we will (and will not) schedule, stated honestly.
 *
 * The four outcomes are deliberately distinct. "We have no schedule for that
 * species" is a real answer we can only give once the template catalog has
 * actually loaded; saying it while the read is in flight — or after it failed
 * — would publish an unread as a finding, which is the same defect class the
 * dashboard metrics were fixed for.
 */
function ScheduleNotice({
  hasSpecies,
  isPending,
  isError,
  templateName,
  templateDescription,
  applySchedule,
  onToggleSchedule,
}: ScheduleNoticeProps) {
  const { t } = useTranslation();

  if (!hasSpecies) {
    return <p className="text-sm text-gray-600">{t('firstRun.plant.scheduleNoSpecies')}</p>;
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
      <p className="text-sm text-gray-600" aria-live="polite">
        {t('firstRun.plant.scheduleCheckFailed')}
      </p>
    );
  }

  if (!templateName) {
    return (
      <p className="text-sm text-gray-600" aria-live="polite">
        {t('firstRun.plant.scheduleUnknown')}
      </p>
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
