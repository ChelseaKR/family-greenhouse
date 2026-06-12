import { Fragment, useEffect } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plant, plantService } from '@/services/plantService';
import { getErrorMessage } from '@/services/api';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';

const plantSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  species: z.string().max(100).optional(),
  location: z.string().max(100).optional(),
  notes: z.string().max(1000).optional(),
});

type PlantFormData = z.infer<typeof plantSchema>;

interface EditPlantModalProps {
  plant: Plant;
  isOpen: boolean;
  onClose: () => void;
}

export function EditPlantModal({ plant, isOpen, onClose }: EditPlantModalProps) {
  const queryClient = useQueryClient();
  const householdId = useActiveHouseholdId();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<PlantFormData>({
    resolver: zodResolver(plantSchema),
    defaultValues: {
      name: plant.name,
      species: plant.species || '',
      location: plant.location || '',
      notes: plant.notes || '',
    },
  });

  useEffect(() => {
    if (isOpen) {
      reset({
        name: plant.name,
        species: plant.species || '',
        location: plant.location || '',
        notes: plant.notes || '',
      });
    }
  }, [isOpen, plant, reset]);

  const mutation = useMutation({
    mutationFn: (data: PlantFormData) =>
      plantService.updatePlant(plant.id, {
        name: data.name,
        species: data.species || undefined,
        location: data.location || undefined,
        notes: data.notes || undefined,
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
          <div className="fixed inset-0 bg-gray-500/75 transition-opacity" />
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
              <Dialog.Panel className="relative transform overflow-hidden rounded-lg bg-white px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:w-full sm:max-w-lg sm:p-6">
                <div className="absolute right-0 top-0 pr-4 pt-4">
                  <button
                    type="button"
                    className="rounded-md bg-white text-gray-600 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                    onClick={handleClose}
                  >
                    <span className="sr-only">Close</span>
                    <XMarkIcon className="h-6 w-6" aria-hidden="true" />
                  </button>
                </div>

                <Dialog.Title
                  as="h3"
                  className="font-serif text-2xl font-semibold tracking-tight text-gray-900 mb-4"
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

                  <Input label="Species" error={errors.species?.message} {...register('species')} />

                  <Input
                    label="Location"
                    error={errors.location?.message}
                    {...register('location')}
                  />

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
