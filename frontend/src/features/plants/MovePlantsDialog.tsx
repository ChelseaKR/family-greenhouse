import { Fragment, useEffect, useMemo, useState } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { getErrorMessage } from '@/services/api';
import { plantService, type Plant } from '@/services/plantService';
import { spaceService } from '@/services/spaceService';
import { plantLocationLabel, spaceMap } from '@/utils/spaces';
import { toast } from '@/store/toastStore';

interface MovePlantsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Supplying one plant turns the bulk picker into a focused quick move. */
  plant?: Plant;
}

export function MovePlantsDialog({ isOpen, onClose, plant }: MovePlantsDialogProps) {
  const { t } = useTranslation();
  const householdId = useActiveHouseholdId();
  const queryClient = useQueryClient();
  const [selectedPlants, setSelectedPlants] = useState<Set<string>>(new Set());
  const [spaceId, setSpaceId] = useState('');
  const [placementNote, setPlacementNote] = useState('');

  const { data: plants } = useQuery({
    queryKey: ['plants', householdId],
    queryFn: () => plantService.getPlants(),
    enabled: isOpen && !plant,
  });
  const { data: spaces = [] } = useQuery({
    queryKey: ['spaces', householdId],
    queryFn: spaceService.getSpaces,
    enabled: isOpen,
  });
  const spacesById = useMemo(() => spaceMap(spaces), [spaces]);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedPlants(new Set(plant ? [plant.id] : []));
    setSpaceId(plant?.spaceId ?? '');
    setPlacementNote(plant?.placementNote ?? '');
  }, [isOpen, plant]);

  const move = useMutation({
    mutationFn: () =>
      plantService.movePlants({
        plantIds: [...selectedPlants],
        spaceId: spaceId || null,
        placementNote: selectedPlants.size === 1 ? placementNote.trim() || null : null,
      }),
    onSuccess: (moved) => {
      queryClient.invalidateQueries({ queryKey: ['plants', householdId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', householdId] });
      toast.success(t('spaces.moveSuccess', { count: moved.length }));
      handleClose();
    },
  });

  function handleClose() {
    setSelectedPlants(new Set());
    setSpaceId('');
    setPlacementNote('');
    move.reset();
    onClose();
  }

  function togglePlant(plantId: string) {
    setSelectedPlants((current) => {
      const next = new Set(current);
      if (next.has(plantId)) next.delete(plantId);
      else next.add(plantId);
      return next;
    });
  }

  const availablePlants = plant ? [plant] : (plants ?? []);
  const canMove = selectedPlants.size > 0 && selectedPlants.size <= 50;

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
              <Dialog.Panel className="relative w-full transform overflow-hidden rounded-lg border border-primary-100/70 bg-paper px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:max-w-lg sm:p-6">
                <button
                  type="button"
                  onClick={handleClose}
                  className="absolute right-3 top-3 inline-flex min-h-touch min-w-touch items-center justify-center rounded-md text-gray-500 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                >
                  <span className="sr-only">{t('common.close')}</span>
                  <XMarkIcon className="h-6 w-6" aria-hidden="true" />
                </button>

                <Dialog.Title as="h3" className="pr-12 font-serif text-2xl tracking-tight text-ink">
                  {plant
                    ? t('spaces.quickMoveTitle', { name: plant.name })
                    : t('spaces.bulkMoveTitle')}
                </Dialog.Title>
                <p className="mt-1 text-sm text-gray-600">{t('spaces.moveDescription')}</p>

                {move.isError && (
                  <Alert variant="error" className="mt-4">
                    {getErrorMessage(move.error)}
                  </Alert>
                )}

                <div className="mt-5 space-y-4">
                  {!plant && (
                    <div>
                      <p className="label">
                        {t('spaces.selectedPlants', { count: selectedPlants.size })}
                      </p>
                      {!plants ? (
                        <div className="flex justify-center py-6">
                          <LoadingSpinner />
                        </div>
                      ) : (
                        <ul className="max-h-60 divide-y divide-primary-100/60 overflow-y-auto rounded-md border border-primary-100/70">
                          {availablePlants.map((candidate) => (
                            <li key={candidate.id}>
                              <label className="flex min-h-touch cursor-pointer items-center gap-3 px-3 py-2 hover:bg-parchment/60">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4"
                                  checked={selectedPlants.has(candidate.id)}
                                  disabled={
                                    !selectedPlants.has(candidate.id) && selectedPlants.size >= 50
                                  }
                                  onChange={() => togglePlant(candidate.id)}
                                />
                                <span className="min-w-0 flex-1 truncate text-sm text-gray-900">
                                  {candidate.name}
                                </span>
                                <span className="max-w-40 truncate text-xs text-gray-600">
                                  {plantLocationLabel(candidate, spacesById)}
                                </span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  <label className="block">
                    <span className="label">{t('spaces.moveDestination')}</span>
                    <select
                      className="input"
                      value={spaceId}
                      onChange={(event) => setSpaceId(event.target.value)}
                    >
                      <option value="">{t('spaces.unplaced')}</option>
                      {(['inside', 'outside'] as const).map((environment) => {
                        const options = spaces.filter((space) => space.environment === environment);
                        return options.length > 0 ? (
                          <optgroup key={environment} label={t(`spaces.${environment}`)}>
                            {options.map((space) => (
                              <option key={space.id} value={space.id}>
                                {space.name}
                              </option>
                            ))}
                          </optgroup>
                        ) : null;
                      })}
                    </select>
                  </label>

                  {selectedPlants.size === 1 && (
                    <label className="block">
                      <span className="label">{t('spaces.placementNoteLabel')}</span>
                      <input
                        className="input"
                        maxLength={120}
                        value={placementNote}
                        placeholder={t('spaces.placementNotePlaceholder')}
                        onChange={(event) => setPlacementNote(event.target.value)}
                      />
                    </label>
                  )}

                  <div className="flex justify-end gap-2 pt-2">
                    <Button variant="secondary" onClick={handleClose}>
                      {t('common.cancel')}
                    </Button>
                    <Button
                      onClick={() => move.mutate()}
                      isLoading={move.isPending}
                      disabled={!canMove}
                    >
                      {t('spaces.moveAction', { count: selectedPlants.size })}
                    </Button>
                  </div>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  );
}
