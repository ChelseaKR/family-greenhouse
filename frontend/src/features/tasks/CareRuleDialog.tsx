import { Fragment } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/Button';

interface CareRuleDialogProps {
  isOpen: boolean;
  /** Plant the task belongs to — named in the title. */
  plantName: string;
  /** Task label ("Water", or a custom type's name) — shown as the eyebrow. */
  taskLabel: string;
  /** The rule itself. Callers only open the dialog when one exists. */
  careRule: string;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * The house rule, shown at the moment someone is about to complete a task —
 * the one place where two people caring for the same plant two different
 * ways can be caught. Opened only when the plant has a rule; there is
 * deliberately no "no rule set" placeholder, which would be a nag on every
 * completion.
 */
export function CareRuleDialog({
  isOpen,
  plantName,
  taskLabel,
  careRule,
  onClose,
  onConfirm,
}: CareRuleDialogProps) {
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
              <Dialog.Panel className="relative w-full transform overflow-hidden rounded-lg bg-paper border border-primary-100/70 px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:max-w-md sm:p-6">
                <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">
                  {taskLabel} · {t('plants.careRule.label')}
                </p>
                <Dialog.Title
                  as="h3"
                  className="mt-1 font-serif text-xl leading-tight tracking-tight text-ink"
                >
                  {t('tasks.careRule.title', { plant: plantName })}
                </Dialog.Title>
                <blockquote className="mt-4 rounded-md border-l-4 border-primary-500 bg-primary-50 px-4 py-3 font-serif text-2xl leading-snug text-ink">
                  {careRule}
                </blockquote>
                <div className="mt-5 grid grid-cols-2 gap-3 sm:mt-4 sm:flex sm:flex-row-reverse [&>button]:w-full sm:[&>button]:w-auto">
                  <Button onClick={onConfirm}>{t('tasks.careRule.confirm')}</Button>
                  <Button variant="secondary" onClick={onClose}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  );
}
