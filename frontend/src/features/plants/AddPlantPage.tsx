import { useState, useMemo } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ArrowLeftIcon, SparklesIcon, CameraIcon } from '@heroicons/react/24/outline';
import { plantService, IdentificationSuggestion } from '@/services/plantService';
import { suggestTaskTemplate, taskService } from '@/services/taskService';
import { speciesService } from '@/services/speciesService';
import { track } from '@/services/analytics';
import { getErrorMessage } from '@/services/api';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Card } from '@/components/Card';
import { Alert } from '@/components/Alert';
import { TitleUnderline } from '@/components/brand/TitleUnderline';
import { SpeciesCombobox } from '@/components/SpeciesCombobox';
import { SuggestedCareCard } from './SuggestedCareCard';
import { PetToxicityNote } from './PetToxicityNote';
import { generatePlantName } from '@/utils/plantNameGenerator';
import { downscaleImage } from '@/utils/image';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { toast } from '@/store/toastStore';
import { taskTypeLabels } from '@/utils/taskTypeConfig';

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// The identify endpoint shares leaf-health's 256 KiB body cap. Downscaling to
// 1024px before encoding lands comfortably under that; MAX_BASE64_CHARS
// mirrors the backend schema's limit so an oversized photo fails fast with a
// clear message instead of a raw "payload too large" from the server.
const IDENTIFY_PHOTO_MAX_EDGE = 1024;
const MAX_BASE64_CHARS = 350_000;

// Rebuilt per-render from the active locale so validation messages translate.
const makeAddPlantSchema = (t: TFunction) =>
  z.object({
    name: z.string().min(1, t('validation.nameRequired')).max(100, t('validation.nameTooLong')),
    species: z.string().max(100, t('validation.speciesTooLong')).optional(),
    location: z.string().max(100, t('validation.locationTooLong')).optional(),
    notes: z.string().max(1000, t('validation.notesTooLong')).optional(),
    tags: z.string().max(200, t('validation.tooManyTags')).optional(),
  });

type AddPlantFormData = z.infer<ReturnType<typeof makeAddPlantSchema>>;

/**
 * Router state passed by PlantDetailPage's "Propagate cutting" action: the
 * new plant is prefilled with the parent's species and linked to it via
 * parentPlantId on submit.
 */
interface PropagationState {
  parentPlantId?: string;
  parentName?: string;
  species?: string | null;
}

async function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function AddPlantPage() {
  useDocumentTitle('Add plant');
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const householdId = useActiveHouseholdId();
  const addPlantSchema = useMemo(() => makeAddPlantSchema(t), [t]);
  // Propagation mode: arriving via "Propagate cutting" links the new plant
  // to its parent and prefills the species. (Router state survives normal
  // navigation; a hard refresh just degrades to a plain add — fine.)
  const propagation = (location.state ?? null) as PropagationState | null;
  const parentPlantId = propagation?.parentPlantId;
  const [error, setError] = useState<string | null>(null);
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [pickedPreview, setPickedPreview] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [suggestions, setSuggestions] = useState<IdentificationSuggestion[] | null>(null);
  const [identifyNotice, setIdentifyNotice] = useState<string | null>(null);
  const [isIdentifying, setIsIdentifying] = useState(false);
  const [autoAddCareTasks, setAutoAddCareTasks] = useState(true);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    getValues,
    formState: { errors },
  } = useForm<AddPlantFormData>({
    resolver: zodResolver(addPlantSchema),
    defaultValues: {
      species: propagation?.species ?? undefined,
    },
  });

  const speciesValue = watch('species') ?? '';
  const nameValue = watch('name') ?? '';
  const [perenualSpeciesId, setPerenualSpeciesId] = useState<number | null>(null);
  const { data: taskTemplates = [] } = useQuery({
    queryKey: ['task-templates'],
    queryFn: taskService.listTemplates,
    staleTime: 60 * 60 * 1000,
  });
  const suggestedTaskTemplate = useMemo(
    () => suggestTaskTemplate(taskTemplates, speciesValue),
    [speciesValue, taskTemplates]
  );

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    setSuggestions(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError('Image must be a JPEG, PNG, or WebP file.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`Image is too large (max ${MAX_BYTES / 1024 / 1024} MB).`);
      return;
    }
    setPickedFile(file);
    const dataUrl = await fileToBase64(file);
    setPickedPreview(dataUrl);
  };

  const runIdentify = async () => {
    if (!pickedFile) return;
    setIsIdentifying(true);
    setError(null);
    setIdentifyNotice(null);
    try {
      // Downscale BEFORE encoding — a raw iPhone photo (multi-MB HEIC/JPEG)
      // blows past the endpoint's body cap and the server rejects it outright.
      const downscaled = await downscaleImage(pickedFile, IDENTIFY_PHOTO_MAX_EDGE);
      const blob: Blob =
        downscaled && ACCEPTED_TYPES.includes(downscaled.type) ? downscaled : pickedFile;
      const dataUrl = await fileToBase64(blob);
      if (dataUrl.length > MAX_BASE64_CHARS) {
        setError('Image is too large to identify — try a smaller or less detailed photo.');
        return;
      }
      const result = await plantService.identifyPlant(dataUrl);
      if (!result.suggestions || result.suggestions.length === 0) {
        setIdentifyNotice('No suggestions came back — fill in the species manually.');
      } else {
        setSuggestions(result.suggestions);
        if (!result.configured) {
          setIdentifyNotice(
            'Demo suggestions shown — configure PLANT_ID_API_KEY for real identification.'
          );
        }
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsIdentifying(false);
    }
  };

  const acceptSuggestion = async (s: IdentificationSuggestion) => {
    track('plant_identified');
    setValue('species', s.scientificName, { shouldValidate: true });
    if (s.commonName && !nameValue) {
      setValue('name', s.commonName, { shouldValidate: true });
    }
    setSuggestions(null);
    // Best-effort: resolve the AI-identified scientific name to a Perenual
    // species id so the suggested-care card and auto-watering task kick in.
    // No Perenual match is fine — the plant just saves without enrichment.
    try {
      const result = await speciesService.search(s.scientificName);
      const exact = result.results.find(
        (r) => r.scientificName.toLowerCase() === s.scientificName.toLowerCase()
      );
      // Guard against out-of-order resolution: if the species field has
      // moved on since this search started (a later "Use" click, or a
      // manual edit), this result is stale — applying it would silently
      // overwrite a newer pick with a mismatched id.
      if (getValues('species') === s.scientificName) {
        setPerenualSpeciesId(exact?.id ?? null);
      }
    } catch {
      // Search failures shouldn't block the user from saving the plant.
    }
  };

  const mutation = useMutation({
    mutationFn: async (data: AddPlantFormData) => {
      // Discriminate the first-plant activation event from subsequent adds
      // using the AUTHORITATIVE pre-create list, not just whatever happens to
      // be in cache. A deep-link or "Propagate cutting" entry to /plants/new
      // never loaded the Plants list, so reading getQueryData alone would
      // mislabel an existing user's Nth plant as their first and inflate the
      // funnel. Use the cache when warm; only the cold paths fetch. Best-effort
      // — analytics must never block plant creation.
      let wasFirstPlant = false;
      try {
        const priorPlants =
          queryClient.getQueryData<unknown[]>(['plants', householdId]) ??
          ((await queryClient.ensureQueryData({
            queryKey: ['plants', householdId],
            queryFn: () => plantService.getPlants('active'),
          })) as unknown[]);
        wasFirstPlant = priorPlants.length === 0;
      } catch {
        // Unknown (list fetch failed) → keep the safe default (false) rather
        // than risk over-counting 'first'. Analytics never blocks creation.
      }

      const tags = (data.tags ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 10);
      const plant = await plantService.createPlant({
        name: data.name,
        species: data.species || undefined,
        location: data.location || undefined,
        notes: data.notes || undefined,
        tags: tags.length > 0 ? tags : undefined,
        perenualSpeciesId: perenualSpeciesId ?? undefined,
        // Propagation mode: link the cutting to its parent.
        parentPlantId: parentPlantId || undefined,
      });
      if (pickedFile) {
        // Downscale client-side (max 1600px long edge, WebP ~0.8 / JPEG
        // fallback); upload the original if the canvas pipeline fails. The
        // presign contentType must match the PUT's Content-Type header.
        const downscaled = await downscaleImage(pickedFile);
        const blob: Blob =
          downscaled && ACCEPTED_TYPES.includes(downscaled.type) ? downscaled : pickedFile;
        if (blob.size > MAX_BYTES) {
          throw new Error(`Image is too large (max ${MAX_BYTES / 1024 / 1024} MB).`);
        }
        const contentType = blob.type || pickedFile.type;
        const { uploadUrl, imageUrl } = await plantService.getImageUploadUrl(plant.id, contentType);
        await plantService.uploadImage(uploadUrl, blob, contentType, setUploadProgress);
        await plantService.confirmImageUpload(plant.id, imageUrl);
      }
      // Best-effort: seed the visible, user-approved species care plan. A
      // curated bundle wins because it covers the whole routine; Perenual's
      // water-only cadence remains the fallback for recognized species that
      // do not match a curated bundle.
      let tasksAdded = 0;
      let taskSetupFailed = false;
      if (autoAddCareTasks && suggestedTaskTemplate) {
        try {
          const result = await taskService.applyTemplate(plant.id, suggestedTaskTemplate.id);
          tasksAdded = result.created.length;
        } catch {
          taskSetupFailed = true;
        }
      } else if (autoAddCareTasks && perenualSpeciesId) {
        try {
          const suggestion = await speciesService.careSuggestions(perenualSpeciesId);
          if (suggestion?.wateringDays && suggestion.wateringDays > 0) {
            await taskService.createTask({
              plantId: plant.id,
              type: 'water',
              frequency: suggestion.wateringDays,
            });
            tasksAdded = 1;
          }
        } catch {
          taskSetupFailed = true;
        }
      }
      return { plant, wasFirstPlant, tasksAdded, taskSetupFailed };
    },
    onSuccess: ({ plant, wasFirstPlant, tasksAdded, taskSetupFailed }) => {
      track('plant_added', { ordinal: wasFirstPlant ? 'first' : 'subsequent' });
      queryClient.invalidateQueries({ queryKey: ['plants', householdId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', householdId] });
      toast.success(
        tasksAdded > 0
          ? `${plant.name} added with ${tasksAdded} care task${tasksAdded === 1 ? '' : 's'}`
          : `${plant.name} added`
      );
      if (taskSetupFailed) {
        toast.info('The plant was saved, but its recommended tasks could not be added.');
      }
      navigate(`/plants/${plant.id}`);
    },
    onError: (err) => {
      setError(getErrorMessage(err));
    },
  });

  const onSubmit = (data: AddPlantFormData) => {
    setError(null);
    mutation.mutate(data);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Link
        to="/plants"
        className="inline-flex items-center text-sm text-gray-600 hover:text-gray-800"
      >
        <ArrowLeftIcon className="h-4 w-4 mr-1" aria-hidden="true" />
        Back to plants
      </Link>

      <div>
        <h1 className="font-serif text-3xl text-ink leading-tight tracking-tight">
          Add a new plant
        </h1>
        <TitleUnderline className="mt-1 h-3 w-28 text-primary-600" />
        <p className="mt-1 text-sm text-gray-600">
          Enter the details of your plant to start tracking its care.
        </p>
      </div>

      <Card>
        {parentPlantId && (
          <Alert variant="info" className="mb-6">
            🌱{' '}
            {t('plants.propagate.banner', {
              name: propagation?.parentName ?? t('plants.title'),
            })}{' '}
            {t('plants.propagate.bannerHint')}
          </Alert>
        )}
        {error && (
          <Alert variant="error" className="mb-6">
            {error}
          </Alert>
        )}
        {identifyNotice && (
          <Alert variant="info" className="mb-6">
            {identifyNotice}
          </Alert>
        )}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6" noValidate>
          {/* Photo + identification */}
          <div className="space-y-3">
            <span className="label">Photo (optional)</span>
            <div className="flex items-start gap-4">
              <div className="h-32 w-32 flex-shrink-0 overflow-hidden rounded-lg bg-parchment">
                {pickedPreview ? (
                  <img
                    src={pickedPreview}
                    alt="Selected plant photo preview"
                    width={128}
                    height={128}
                    decoding="async"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-primary-300">
                    <CameraIcon className="h-10 w-10" aria-hidden="true" />
                  </div>
                )}
              </div>
              {/* min-w-0 + w-full/max-w-full: <input type="file"> has a large
                  intrinsic min-width in Chrome, which otherwise overflows the
                  viewport on small screens and breaks tap targets. */}
              <div className="min-w-0 flex-1 space-y-2">
                <label className="block">
                  <span className="sr-only">Choose a photo</span>
                  <input
                    type="file"
                    accept={ACCEPTED_TYPES.join(',')}
                    onChange={handleFilePick}
                    className="block w-full max-w-full text-sm file:mr-4 file:rounded-md file:border-0 file:bg-primary-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary-700 hover:file:bg-primary-100"
                  />
                </label>
                {pickedFile && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={runIdentify}
                    isLoading={isIdentifying}
                    leftIcon={<SparklesIcon className="h-4 w-4" aria-hidden="true" />}
                  >
                    Identify from photo
                  </Button>
                )}
                {mutation.isPending && pickedFile && (
                  <div
                    className="h-2 w-full overflow-hidden rounded-full bg-gray-200"
                    role="progressbar"
                    aria-valuenow={Math.round(uploadProgress * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="h-full bg-primary-500 transition-[width]"
                      style={{ width: `${Math.round(uploadProgress * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            </div>
            {suggestions && suggestions.length > 0 && (
              <ul className="rounded-md border border-primary-100/70 divide-y divide-primary-100/60">
                {suggestions.map((s) => (
                  <li
                    key={s.scientificName}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {s.commonName ?? s.scientificName}
                      </p>
                      <p className="text-xs italic text-gray-600">
                        {s.scientificName} • {(s.probability * 100).toFixed(0)}% confidence
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => acceptSuggestion(s)}
                    >
                      Use
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-1">
            <Input
              label="Plant name"
              required
              placeholder="e.g., Living Room Monstera"
              error={errors.name?.message}
              {...register('name')}
            />
            <button
              type="button"
              className="inline-flex min-h-touch items-center text-xs text-primary-700 hover:text-primary-600"
              onClick={() => setValue('name', generatePlantName(), { shouldValidate: true })}
            >
              ✨ Generate a fun name
            </button>
          </div>

          <SpeciesCombobox
            value={speciesValue}
            onChange={(v) => setValue('species', v, { shouldValidate: true })}
            onPick={(entry) => {
              if (!nameValue) {
                setValue('name', entry.common, { shouldValidate: true });
              }
            }}
            onPerenualPick={setPerenualSpeciesId}
            error={errors.species?.message}
            helperText="Type to search common names; pick a suggestion to autofill the scientific name."
          />

          <PetToxicityNote perenualSpeciesId={perenualSpeciesId} />

          <SuggestedCareCard
            perenualSpeciesId={perenualSpeciesId}
            showWateringTaskNotice={autoAddCareTasks && !suggestedTaskTemplate}
          />

          {suggestedTaskTemplate && (
            <div
              className="rounded-lg border border-primary-200 bg-primary-50 p-4"
              aria-label="Recommended care tasks"
            >
              <label
                htmlFor="auto-add-care-tasks"
                className="flex cursor-pointer items-start gap-3"
              >
                <span className="sr-only">Automatically add recommended care tasks</span>
                <input
                  id="auto-add-care-tasks"
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded border-primary-300 text-primary-700 focus:ring-primary-500"
                  checked={autoAddCareTasks}
                  onChange={(event) => setAutoAddCareTasks(event.target.checked)}
                />
                <span>
                  <span className="block text-sm font-semibold text-primary-900">
                    Automatically add {suggestedTaskTemplate.name.toLowerCase()} care tasks
                  </span>
                  <span className="mt-1 block text-xs text-primary-800">
                    Based on “{speciesValue}”. You can edit or remove these tasks any time.
                  </span>
                </span>
              </label>
              <ul className="mt-3 grid gap-2 pl-7 text-xs text-primary-900 sm:grid-cols-2">
                {suggestedTaskTemplate.tasks.map((task) => (
                  <li key={`${task.type}-${task.customType ?? ''}`}>
                    <span className="font-medium">
                      {task.customType || taskTypeLabels[task.type]}
                    </span>{' '}
                    every {task.frequencyDays} day{task.frequencyDays === 1 ? '' : 's'}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Input
            label="Location"
            placeholder="e.g., Living room, by the window"
            error={errors.location?.message}
            {...register('location')}
          />

          <Input
            label="Tags"
            placeholder="tropical, low-light, gift"
            helperText="Comma-separated. Up to 10 tags. Useful for filtering later."
            error={errors.tags?.message}
            {...register('tags')}
          />

          <div>
            <label htmlFor="notes" className="label">
              Notes
            </label>
            <textarea
              id="notes"
              rows={4}
              className="input"
              placeholder="Any additional notes about this plant..."
              {...register('notes')}
            />
            {errors.notes?.message && <p className="error-message">{errors.notes.message}</p>}
          </div>

          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={() => navigate('/plants')}>
              Cancel
            </Button>
            <Button type="submit" isLoading={mutation.isPending}>
              Add plant
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
