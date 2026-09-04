import { Fragment, useEffect, useState } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/Button';

/** Mirrors the server's cap (models/schemas.ts ASK_HELP_NOTE_MAX_LENGTH). */
export const ASK_NOTE_MAX_LENGTH = 200;

interface AskFamilyDialogProps {
  isOpen: boolean;
  /** Plant the task belongs to — named in the title. */
  plantName: string;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (note: string) => void;
}

/**
 * "Ask family to do it" (ADR 0024).
 *
 * The note is optional and the dialog says so: the ask itself is the point,
 * and a required "why" would turn a two-second favour into an explanation
 * people skip. Sending puts the occurrence up for grabs and tells the
 * household — the confirm copy states that, because the button has a real
 * side effect on other people's phones.
 */
export function AskFamilyDialog({
  isOpen,
  plantName,
  isPending,
  onClose,
  onConfirm,
}: AskFamilyDialogProps) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');

  // A fresh note per ask: the previous task's "I'm travelling until Sunday"
  // must never ride along on the next one.
  useEffect(() => {
    if (isOpen) setNote('');
  }, [isOpen]);

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
              <Dialog.Panel className="relative w-full transform overflow-hidden rounded-lg border border-primary-100/70 bg-paper px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:max-w-md sm:p-6">
                <Dialog.Title
                  as="h3"
                  className="font-serif text-xl leading-tight tracking-tight text-ink"
                >
                  {t('tasks.askFamily.title', { plant: plantName })}
                </Dialog.Title>
                <p className="mt-2 text-sm text-primary-800">{t('tasks.askFamily.explainer')}</p>
                <div className="mt-4">
                  <label htmlFor="ask-family-note" className="label">
                    {t('tasks.askFamily.noteLabel')}
                  </label>
                  <textarea
                    id="ask-family-note"
                    rows={2}
                    className="input"
                    maxLength={ASK_NOTE_MAX_LENGTH}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder={t('tasks.askFamily.notePlaceholder')}
                  />
                </div>
                <div className="mt-5 grid grid-cols-2 gap-3 sm:mt-4 sm:flex sm:flex-row-reverse [&>button]:w-full sm:[&>button]:w-auto">
                  <Button onClick={() => onConfirm(note)} isLoading={isPending}>
                    {t('tasks.askFamily.confirm')}
                  </Button>
                  <Button variant="secondary" onClick={onClose} disabled={isPending}>
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
