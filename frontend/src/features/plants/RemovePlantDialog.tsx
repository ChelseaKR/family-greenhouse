import { Fragment } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { ArchiveBoxIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/Button';

interface RemovePlantDialogProps {
  isOpen: boolean;
  plantName: string;
  isLoading?: boolean;
  onClose: () => void;
  /** Neutral, reversible removal from active care. */
  onArchive: () => void;
  /** Record an outcome — keeps history, removes from active views, restorable. */
  onDied: () => void;
  onGaveAway: () => void;
  /** Permanent hard delete — for mistakes/duplicates. Cannot be undone. */
  onDelete: () => void;
}

/**
 * Removing a plant you cared for isn't a single "delete" — we ask what
 * happened so the history (and the plant-survival metric) survives. "It died"
 * and "I gave it away" record an outcome and can be undone; "Delete
 * permanently" is the irreversible escape hatch for mistakes/duplicates.
 */
export function RemovePlantDialog({
  isOpen,
  plantName,
  isLoading = false,
  onClose,
  onArchive,
  onDied,
  onGaveAway,
  onDelete,
}: RemovePlantDialogProps) {
  const { t } = useTranslation();

  return (
    <Transition.Root show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose}>
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
                <Dialog.Title
                  as="h3"
                  className="font-serif text-xl font-semibold leading-tight tracking-tight text-ink"
                >
                  {t('plants.archive.dialogTitle', { name: plantName })}
                </Dialog.Title>
                <p className="mt-2 text-sm leading-relaxed text-gray-600">
                  {t('plants.archive.dialogDescription')}
                </p>

                <div className="mt-5 flex flex-col gap-2">
                  <Button
                    onClick={onArchive}
                    disabled={isLoading}
                    className="w-full justify-center"
                    leftIcon={<ArchiveBoxIcon className="h-5 w-5" aria-hidden="true" />}
                  >
                    {t('plants.archive.action')}
                  </Button>
                  <p className="my-1 text-center text-xs font-medium uppercase tracking-wide text-gray-500">
                    {t('plants.archive.outcomePrompt')}
                  </p>
                  <Button
                    variant="secondary"
                    onClick={onGaveAway}
                    disabled={isLoading}
                    className="w-full justify-center"
                  >
                    {t('plants.archive.gaveAway')}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={onDied}
                    disabled={isLoading}
                    className="w-full justify-center"
                  >
                    {t('plants.archive.died')}
                  </Button>
                  <button
                    type="button"
                    onClick={onDelete}
                    disabled={isLoading}
                    className="mt-1 text-sm text-red-700 underline underline-offset-2 hover:text-red-800 disabled:opacity-50 min-h-touch"
                  >
                    {t('plants.archive.deletePermanently')}
                  </button>
                </div>

                <div className="mt-5 sm:mt-4">
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={isLoading}
                    className="w-full text-sm text-gray-600 hover:text-gray-800 disabled:opacity-50 min-h-touch"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  );
}
