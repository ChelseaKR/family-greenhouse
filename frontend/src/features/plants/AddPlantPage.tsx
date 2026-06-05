import { useState, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ArrowLeftIcon, SparklesIcon, CameraIcon } from '@heroicons/react/24/outline';
import { plantService, IdentificationSuggestion } from '@/services/plantService';
import { taskService } from '@/services/taskService';
import { speciesService } from '@/services/speciesService';
import { track } from '@/services/analytics';
import { getErrorMessage } from '@/services/api';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Card } from '@/components/Card';
import { Alert } from '@/components/Alert';
import { SpeciesCombobox } from '@/components/SpeciesCombobox';
import { SuggestedCareCard } from './SuggestedCareCard';
import { generatePlantName } from '@/utils/plantNameGenerator';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { toast } from '@/store/toastStore';

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

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

async function fileToBase64(file: File): Promise<string> {
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
  const queryClient = useQueryClient();
  const addPlantSchema = useMemo(() => makeAddPlantSchema(t), [t]);
  const [error, setError] = useState<string | null>(null);
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [pickedPreview, setPickedPreview] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [suggestions, setSuggestions] = useState<IdentificationSuggestion[] | null>(null);
  const [identifyNotice, setIdentifyNotice] = useState<string | null>(null);
  const [isIdentifying, setIsIdentifying] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<AddPlantFormData>({
    resolver: zodResolver(addPlantSchema),
  });

  const speciesValue = watch('species') ?? '';
  const nameValue = watch('name') ?? '';
  const [perenualSpeciesId, setPerenualSpeciesId] = useState<number | null>(null);

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
      const dataUrl = await fileToBase64(pickedFile);
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
      setPerenualSpeciesId(exact?.id ?? null);
    } catch {
      // Search failures shouldn't block the user from saving the plant.
    }
  };

  const mutation = useMutation({
    mutationFn: async (data: AddPlantFormData) => {
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
      });
      if (pickedFile) {
        const { uploadUrl, imageUrl } = await plantService.getImageUploadUrl(plant.id);
        await plantService.uploadImage(uploadUrl, pickedFile, setUploadProgress);
        await plantService.confirmImageUpload(plant.id, imageUrl);
      }
      // Best-effort: if Perenual gave us a watering cadence, seed a task. We
      // don't block plant creation on this — the user can always add tasks
      // manually if the suggestion fetch fails.
      if (perenualSpeciesId) {
        try {
          const suggestion = await speciesService.careSuggestions(perenualSpeciesId);
          if (suggestion?.wateringDays && suggestion.wateringDays > 0) {
            await taskService.createTask({
              plantId: plant.id,
              type: 'water',
              frequency: suggestion.wateringDays,
            });
          }
        } catch {
          // Silent failure is intentional — plant is already saved.
        }
      }
      return plant;
    },
    onSuccess: (plant) => {
      // Read pre-create plants from cache to discriminate the first-plant
      // event (a critical funnel step) from subsequent ones.
      const existing = queryClient.getQueryData(['plants']) as unknown[] | undefined;
      track('plant_added', {
        ordinal: existing && existing.length > 0 ? 'subsequent' : 'first',
      });
      queryClient.invalidateQueries({ queryKey: ['plants'] });
      toast.success(`${plant.name} added`);
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
        <h1 className="text-2xl font-bold text-gray-900">Add a new plant</h1>
        <p className="mt-1 text-sm text-gray-500">
          Enter the details of your plant to start tracking its care.
        </p>
      </div>

      <Card>
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
              <div className="h-32 w-32 flex-shrink-0 overflow-hidden rounded-lg bg-gray-100">
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
                  <div className="flex h-full w-full items-center justify-center text-gray-300">
                    <CameraIcon className="h-10 w-10" aria-hidden="true" />
                  </div>
                )}
              </div>
              <div className="flex-1 space-y-2">
                <label className="block">
                  <span className="sr-only">Choose a photo</span>
                  <input
                    type="file"
                    accept={ACCEPTED_TYPES.join(',')}
                    onChange={handleFilePick}
                    className="block text-sm file:mr-4 file:rounded-md file:border-0 file:bg-primary-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary-700 hover:file:bg-primary-100"
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
              <ul className="rounded-md border border-gray-200 divide-y divide-gray-200">
                {suggestions.map((s) => (
                  <li
                    key={s.scientificName}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {s.commonName ?? s.scientificName}
                      </p>
                      <p className="text-xs italic text-gray-500">
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
              className="text-xs text-primary-700 hover:text-primary-600"
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

          <SuggestedCareCard perenualSpeciesId={perenualSpeciesId} />

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
