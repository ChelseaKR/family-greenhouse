import { Fragment, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { playHaptic } from '@/services/nativeHaptics';
import { NumberStepper } from '@/components/NumberStepper';
import { Dialog, Transition } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { taskService } from '@/services/taskService';
import { getErrorMessage } from '@/services/api';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';
import { hasNativeFormSheet } from '@/lib/platform';
import { addTaskFormRequest, formSheetValues, type AddTaskValues } from '@/config/nativeFormSheet';

const taskSchema = z.object({
  type: z.enum(['water', 'fertilize', 'prune', 'repot', 'custom']),
  customType: z.string().max(50).optional(),
  frequency: z.number().min(1, 'Frequency must be at least 1 day').max(365),
  notes: z.string().max(500).optional(),
});

type TaskFormData = z.infer<typeof taskSchema>;

interface AddTaskModalProps {
  plantId: string;
  isOpen: boolean;
  onClose: () => void;
}

export function AddTaskModal({ plantId, isOpen, onClose }: AddTaskModalProps) {
  const queryClient = useQueryClient();
  const householdId = useActiveHouseholdId();
  const { t } = useTranslation();

  const {
    register,
    handleSubmit,
    watch,
    reset,
    setValue,
    formState: { errors },
  } = useForm<TaskFormData>({
    resolver: zodResolver(taskSchema),
    defaultValues: {
      type: 'water',
      frequency: 7,
    },
  });

  const taskType = watch('type');

  const mutation = useMutation({
    mutationFn: taskService.createTask,
    onSuccess: () => {
      playHaptic('added');
      queryClient.invalidateQueries({ queryKey: ['plants', householdId, plantId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', householdId] });
      reset();
      onClose();
    },
  });

  const onSubmit = (data: TaskFormData) => {
    mutation.mutate({
      plantId,
      type: data.type,
      customType: data.type === 'custom' ? data.customType : undefined,
      frequency: data.frequency,
      notes: data.notes || undefined,
    });
  };

  const handleClose = () => {
    reset();
    mutation.reset();
    onClose();
  };

  // In the iOS app: the same form as a native sheet (config/nativeFormSheet.ts).
  // Only the sheet's own Add button returns values; Cancel, a swipe down or
  // anything else closes this without writing. A save the server refuses
  // opens the sheet again with what was entered and the reason.
  const native = hasNativeFormSheet();
  const latest = useRef({ onClose, mutation, plantId, t });
  latest.current = { onClose, mutation, plantId, t };
  useEffect(() => {
    if (!isOpen || !native) return;
    let gone = false;
    let token: string | null = null;
    const ask = async (values: AddTaskValues, message?: string): Promise<void> => {
      const { presentFormSheet } = await import('@/services/nativeFormSheet');
      if (gone) return;
      const now = latest.current;
      const answer = await presentFormSheet(addTaskFormRequest(now.t, values, message), (tk) => {
        token = tk;
      });
      token = null;
      if (gone) return;
      const chosen = formSheetValues(answer);
      if (!chosen) {
        now.onClose();
        return;
      }
      try {
        await now.mutation.mutateAsync({
          plantId: now.plantId,
          type: chosen.type,
          customType: chosen.type === 'custom' ? chosen.customType : undefined,
          frequency: chosen.frequency,
          notes: chosen.notes || undefined,
        });
      } catch (err) {
        if (!gone) await ask(chosen, getErrorMessage(err));
      }
    };
    void ask({ type: 'water', customType: '', frequency: 7, notes: '' });
    return () => {
      gone = true;
      if (token) {
        const closing = token;
        void import('@/services/nativeFormSheet').then(({ dismissFormSheet }) =>
          dismissFormSheet(closing)
        );
      }
    };
  }, [isOpen, native]);

  if (native) return null;

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

        <div className="fixed inset-0 z-10 overflow-y-auto safe-area-y">
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
                    className="inline-flex min-h-touch min-w-touch items-center justify-center rounded-md bg-paper text-gray-600 hover:text-gray-800 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500"
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
                  Add care task
                </Dialog.Title>

                {mutation.isError && (
                  <Alert variant="error" className="mb-4">
                    {getErrorMessage(mutation.error)}
                  </Alert>
                )}

                <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
                  <div>
                    <label htmlFor="type" className="label">
                      Task type
                    </label>
                    <select id="type" className="input" {...register('type')}>
                      <option value="water">Water</option>
                      <option value="fertilize">Fertilize</option>
                      <option value="prune">Prune</option>
                      <option value="repot">Repot</option>
                      <option value="custom">Custom</option>
                    </select>
                  </div>

                  {taskType === 'custom' && (
                    <Input
                      label="Custom task name"
                      required
                      placeholder="e.g., Rotate plant"
                      error={errors.customType?.message}
                      {...register('customType')}
                    />
                  )}

                  <NumberStepper
                    value={Number(watch('frequency'))}
                    min={1}
                    max={365}
                    onStep={(next) =>
                      setValue('frequency', next, { shouldDirty: true, shouldValidate: true })
                    }
                    decreaseLabel={t('tasks.frequencyStepper.less')}
                    increaseLabel={t('tasks.frequencyStepper.more')}
                  >
                    <Input
                      label="Frequency (days)"
                      type="number"
                      min={1}
                      max={365}
                      required
                      error={errors.frequency?.message}
                      {...register('frequency', { valueAsNumber: true })}
                    />
                  </NumberStepper>

                  <div>
                    <label htmlFor="notes" className="label">
                      Notes
                    </label>
                    <textarea
                      id="notes"
                      rows={3}
                      className="input"
                      placeholder="Any notes about this task..."
                      {...register('notes')}
                    />
                  </div>

                  <div className="flex justify-end gap-3 pt-4">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={handleClose}
                      disabled={mutation.isPending}
                    >
                      Cancel
                    </Button>
                    <Button type="submit" isLoading={mutation.isPending}>
                      Add task
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
