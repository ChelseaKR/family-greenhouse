import { Fragment, useRef } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { Button } from './Button';

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'primary';
  isLoading?: boolean;
}

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  isLoading = false,
}: ConfirmDialogProps) {
  // Initial focus goes to Cancel, never to the confirm button. The confirm
  // button is FIRST in DOM order (the wrapper reverses it visually on wide
  // screens), so Headless UI's default — first tabbable element in the panel —
  // lands a keyboard or screen-reader user directly on the destructive
  // control, where Enter or Space is enough to destroy the record. Reordering
  // the DOM instead would flip the button positions on the narrow two-column
  // layout, so the ref is the change that fixes focus without moving anything
  // a sighted user is looking at.
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  return (
    <Transition.Root show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose} initialFocus={cancelRef}>
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
                <div className="sm:flex sm:items-start">
                  <div
                    className={`mx-auto flex h-12 w-12 shrink-0 items-center justify-center rounded-full sm:mx-0 sm:h-10 sm:w-10 ${
                      variant === 'danger' ? 'bg-red-100' : 'bg-primary-100'
                    }`}
                  >
                    <ExclamationTriangleIcon
                      className={`h-6 w-6 ${
                        variant === 'danger' ? 'text-red-600' : 'text-primary-700'
                      }`}
                      aria-hidden="true"
                    />
                  </div>
                  <div className="mt-3 text-center sm:ml-4 sm:mt-0 sm:text-left">
                    <Dialog.Title
                      as="h3"
                      className="font-serif text-xl leading-tight tracking-tight text-ink"
                    >
                      {title}
                    </Dialog.Title>
                    <div className="mt-2">
                      {/* Dialog.Description, not a plain <p>: Headless UI wires
                          the panel's aria-describedby from this component only.
                          `message` is where the consequences live at all eight
                          call sites — without the association a screen reader
                          announces the title and the focused button and nothing
                          in between, which for DoubleCarePrompt means the entire
                          decision is never spoken. */}
                      <Dialog.Description as="p" className="text-sm leading-relaxed text-gray-600">
                        {message}
                      </Dialog.Description>
                    </div>
                  </div>
                </div>
                <div className="mt-5 grid grid-cols-2 gap-3 sm:mt-4 sm:flex sm:flex-row-reverse [&>button]:w-full sm:[&>button]:w-auto">
                  <Button
                    variant={variant === 'danger' ? 'danger' : 'primary'}
                    onClick={onConfirm}
                    isLoading={isLoading}
                  >
                    {confirmLabel}
                  </Button>
                  <Button
                    ref={cancelRef}
                    variant="secondary"
                    onClick={onClose}
                    disabled={isLoading}
                  >
                    {cancelLabel}
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
