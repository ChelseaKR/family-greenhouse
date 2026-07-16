import { Fragment, useEffect, useState } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plant, plantService } from '@/services/plantService';
import { getErrorMessage } from '@/services/api';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';
import { SpeciesCombobox } from '@/components/SpeciesCombobox';
import { SpacePicker } from './SpacePicker';

const plantSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  species: z.string().max(100).optional(),
  spaceId: z.string().optional(),
  placementNote: z.string().max(120).optional(),
  summerSpaceId: z.string().optional(),
  winterSpaceId: z.string().optional(),
  notes: z.string().max(1000).optional(),
});

type PlantFormData = z.infer<typeof plantSchema>;

interface EditPlantModalProps {
  plant: Plant;
  isOpen: boolean;
  onClose: () => void;
}

export function EditPlantModal({ plant, isOpen, onClose }: EditPlantModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const householdId = useActiveHouseholdId();

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<PlantFormData>({
    resolver: zodResolver(plantSchema),
    defaultValues: {
      name: plant.name,
      species: plant.species || '',
      spaceId: plant.spaceId || '',
      placementNote: plant.placementNote || '',
      summerSpaceId: plant.summerSpaceId || '',
      winterSpaceId: plant.winterSpaceId || '',
      notes: plant.notes || '',
    },
  });

  const [perenualSpeciesId, setPerenualSpeciesId] = useState<number | null>(
    plant.perenualSpeciesId ?? null
  );
  const speciesValue = watch('species') ?? '';
  const spaceIdValue = watch('spaceId') ?? '';
  const summerSpaceIdValue = watch('summerSpaceId') ?? '';
  const winterSpaceIdValue = watch('winterSpaceId') ?? '';

  useEffect(() => {
    if (isOpen) {
      reset({
        name: plant.name,
        species: plant.species || '',
        spaceId: plant.spaceId || '',
        placementNote: plant.placementNote || '',
        summerSpaceId: plant.summerSpaceId || '',
        winterSpaceId: plant.winterSpaceId || '',
        notes: plant.notes || '',
      });
      setPerenualSpeciesId(plant.perenualSpeciesId ?? null);
    }
  }, [isOpen, plant, reset]);

  const mutation = useMutation({
    mutationFn: (data: PlantFormData) =>
      plantService.updatePlant(plant.id, {
        name: data.name,
        species: data.species || undefined,
        spaceId: data.spaceId || null,
        placementNote: data.placementNote || null,
        summerSpaceId: data.summerSpaceId || null,
        winterSpaceId: data.winterSpaceId || null,
        notes: data.notes || undefined,
        // Always explicit, including null — omitting it would leave the
        // backend's existing link untouched and reintroduce stale care/
        // toxicity data after the species text is edited away from it.
        perenualSpeciesId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plants', householdId] });
      onClose();
    },
  });

  const onSubmit = (data: PlantFormData) => {
    mutation.mutate(data);
  };

  const handleClose = () => {
    reset();
    mutation.reset();
    onClose();
  };

  return (
    <Transition.Root show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={handleClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-primary-950/70 transition-opacity" />
        </Transition.Child>

        <div className="fixed inset-0 z-10 overflow-y-auto">
          <div className="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
              enterTo="opacity-100 translate-y-0 sm:scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 translate-y-0 sm:scale-100"
              leaveTo="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
            >
              <Dialog.Panel className="relative w-full transform overflow-hidden rounded-lg bg-paper border border-primary-100/70 px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:max-w-lg sm:p-6">
                <div className="absolute right-0 top-0 pr-4 pt-4">
                  <button
                    type="button"
                    className="inline-flex min-h-touch min-w-touch items-center justify-center rounded-md bg-paper text-gray-600 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                    onClick={handleClose}
                  >
                    <span className="sr-only">Close</span>
                    <XMarkIcon className="h-6 w-6" aria-hidden="true" />
                  </button>
                </div>

                <Dialog.Title
                  as="h3"
                  className="mb-4 pr-12 font-serif text-2xl tracking-tight text-ink"
                >
                  Edit plant
                </Dialog.Title>

                {mutation.isError && (
                  <Alert variant="error" className="mb-4">
                    {getErrorMessage(mutation.error)}
                  </Alert>
                )}

                <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
                  <Input
                    label="Plant name"
                    required
                    error={errors.name?.message}
                    {...register('name')}
                  />

                  <SpeciesCombobox
                    value={speciesValue}
                    onChange={(v) => setValue('species', v, { shouldValidate: true })}
                    onPerenualPick={setPerenualSpeciesId}
                    error={errors.species?.message}
                  />

                  <SpacePicker
                    value={spaceIdValue}
                    onChange={(spaceId) => setValue('spaceId', spaceId, { shouldValidate: true })}
                    error={errors.spaceId?.message}
                  />

                  <Input
                    label={t('spaces.placementNoteLabel')}
                    placeholder={t('spaces.placementNotePlaceholder')}
                    helperText={t('spaces.placementNoteSitterHint')}
                    error={errors.placementNote?.message}
                    {...register('placementNote')}
                  />

                  <fieldset className="space-y-3 rounded-lg border border-primary-100/70 bg-parchment/40 p-4">
                    <legend className="px-1 text-sm font-semibold text-ink">
                      {t('seasonalHomes.title')}
                    </legend>
                    <p className="text-sm text-gray-600">{t('seasonalHomes.description')}</p>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <SpacePicker
                        id="plant-summer-space"
                        label={t('seasonalHomes.summerLabel')}
                        value={summerSpaceIdValue}
                        onChange={(spaceId) =>
                          setValue('summerSpaceId', spaceId, { shouldValidate: true })
                        }
                        error={errors.summerSpaceId?.message}
                        allowCreate={false}
                        emptyLabel={t('seasonalHomes.notSet')}
                      />
                      <SpacePicker
                        id="plant-winter-space"
                        label={t('seasonalHomes.winterLabel')}
                        value={winterSpaceIdValue}
                        onChange={(spaceId) =>
                          setValue('winterSpaceId', spaceId, { shouldValidate: true })
                        }
                        error={errors.winterSpaceId?.message}
                        allowCreate={false}
                        emptyLabel={t('seasonalHomes.notSet')}
                      />
                    </div>
                  </fieldset>

                  <div>
                    <label htmlFor="notes" className="label">
                      Notes
                    </label>
                    <textarea id="notes" rows={4} className="input" {...register('notes')} />
                  </div>

                  <div className="flex justify-end gap-3 pt-4">
                    <Button type="button" variant="secondary" onClick={handleClose}>
                      Cancel
                    </Button>
                    <Button type="submit" isLoading={mutation.isPending}>
                      Save changes
                    </Button>
                  </div>
                </form>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  );
}
