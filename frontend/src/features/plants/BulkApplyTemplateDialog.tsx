import { Fragment, useState } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { Alert } from '@/components/Alert';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { plantService, type Plant } from '@/services/plantService';
import { taskService } from '@/services/taskService';
import { getErrorMessage } from '@/services/api';

interface BulkApplyTemplateDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Modal that lets the user pick a recurring task template + check off the
 * plants to apply it to in one go. Backend caps at 50 plants per call;
 * we surface that as a soft limit in the UI rather than letting the call
 * silently truncate.
 */
export function BulkApplyTemplateDialog({ isOpen, onClose }: BulkApplyTemplateDialogProps) {
  const queryClient = useQueryClient();
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [selectedPlants, setSelectedPlants] = useState<Set<string>>(new Set());

  const { data: plants } = useQuery({
    queryKey: ['plants'],
    queryFn: plantService.getPlants,
    enabled: isOpen,
  });

  const { data: templates } = useQuery({
    queryKey: ['task-templates'],
    queryFn: taskService.listTemplates,
    enabled: isOpen,
  });

  const apply = useMutation({
    mutationFn: () => taskService.applyTemplateBulk([...selectedPlants], selectedTemplate),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plants'] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      handleClose();
    },
  });

  function handleClose() {
    setSelectedTemplate('');
    setSelectedPlants(new Set());
    apply.reset();
    onClose();
  }

  function togglePlant(p: Plant) {
    setSelectedPlants((prev) => {
      const next = new Set(prev);
      if (next.has(p.id)) next.delete(p.id);
      else next.add(p.id);
      return next;
    });
  }

  const overLimit = selectedPlants.size > 50;
  const canApply = !!selectedTemplate && selectedPlants.size > 0 && !overLimit;

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
          <div className="fixed inset-0 bg-gray-500/75" />
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
                    onClick={handleClose}
                    className="rounded-md bg-white text-gray-500 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                  >
                    <span className="sr-only">Close</span>
                    <XMarkIcon className="h-6 w-6" aria-hidden="true" />
                  </button>
                </div>

                <Dialog.Title
                  as="h3"
                  className="font-serif text-2xl font-semibold tracking-tight text-gray-900 mb-4"
                >
                  Apply care template
                </Dialog.Title>

                {apply.isError && (
                  <Alert variant="error" className="mb-4">
                    {getErrorMessage(apply.error)}
                  </Alert>
                )}

                <div className="space-y-4">
                  <div>
                    <label htmlFor="bulk-tpl" className="label">
                      Template
                    </label>
                    <select
                      id="bulk-tpl"
                      className="input"
                      value={selectedTemplate}
                      onChange={(e) => setSelectedTemplate(e.target.value)}
                    >
                      <option value="">— pick one —</option>
                      {templates?.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <p className="label">
                      Plants ({selectedPlants.size} selected
                      {overLimit && ' — over the 50-plant cap, deselect some'})
                    </p>
                    {!plants ? (
                      <div className="flex justify-center py-6">
                        <LoadingSpinner />
                      </div>
                    ) : plants.length === 0 ? (
                      <p className="text-sm text-gray-600">No plants yet.</p>
                    ) : (
                      <ul className="max-h-64 overflow-y-auto rounded-md border border-gray-200 divide-y divide-gray-200">
                        {plants.map((p) => (
                          <li key={p.id}>
                            <label className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 cursor-pointer">
                              <input
                                type="checkbox"
                                className="h-4 w-4"
                                checked={selectedPlants.has(p.id)}
                                onChange={() => togglePlant(p)}
                              />
                              <span className="flex-1 text-sm text-gray-900 truncate">
                                {p.name}
                              </span>
                              {p.species && (
                                <span className="text-xs italic text-gray-500 truncate">
                                  {p.species}
                                </span>
                              )}
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <Button variant="secondary" onClick={handleClose}>
                      Cancel
                    </Button>
                    <Button
                      onClick={() => apply.mutate()}
                      isLoading={apply.isPending}
                      disabled={!canApply}
                    >
                      Apply to {selectedPlants.size} plant{selectedPlants.size === 1 ? '' : 's'}
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
