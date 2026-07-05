import { Fragment, useEffect, useState } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ShareIcon, ClipboardDocumentIcon, CheckIcon } from '@heroicons/react/24/outline';
import { plantService } from '@/services/plantService';
import { Button } from '@/components/Button';
import { Alert } from '@/components/Alert';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { getErrorMessage } from '@/services/api';

interface ShareCuttingDialogProps {
  plantId: string;
  isOpen: boolean;
  onClose: () => void;
}

/**
 * "Share cutting" dialog: mints a 14-day share link for the plant card and
 * presents it for copying. The link is minted once per dialog lifetime (the
 * mutation result is reused on re-open) — codes are cheap but rate-limited,
 * and one stable link is less confusing to paste around a group chat.
 */
export function ShareCuttingDialog({ plantId, isOpen, onClose }: ShareCuttingDialogProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  const shareMutation = useMutation({
    mutationFn: () => plantService.sharePlant(plantId),
  });
  const { mutate: mintShare, data: share } = shareMutation;

  useEffect(() => {
    if (isOpen && !share && !shareMutation.isPending) {
      mintShare();
    }
    if (!isOpen) {
      setCopied(false);
      setCopyError(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleCopy = async () => {
    if (!share) return;
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(share.url);
      setCopied(true);
    } catch {
      // Clipboard API can be unavailable (permissions, insecure context);
      // leave the URL selectable and tell the user to copy manually.
      setCopyError(true);
    }
  };

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
              <Dialog.Panel className="relative transform overflow-hidden rounded-lg bg-paper border border-primary-100/70 px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:w-full sm:max-w-lg sm:p-6">
                <div className="sm:flex sm:items-start">
                  <div className="mx-auto flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-primary-100 sm:mx-0 sm:h-10 sm:w-10">
                    <ShareIcon className="h-6 w-6 text-primary-700" aria-hidden="true" />
                  </div>
                  <div className="mt-3 w-full text-center sm:ml-4 sm:mt-0 sm:text-left">
                    <Dialog.Title
                      as="h3"
                      className="font-serif text-xl font-semibold leading-tight tracking-tight text-ink"
                    >
                      {t('plants.share.title')}
                    </Dialog.Title>
                    <p className="mt-2 text-sm leading-relaxed text-gray-600">
                      {t('plants.share.description')}
                    </p>

                    <div className="mt-4">
                      {shareMutation.isPending && (
                        <div className="flex justify-center py-4">
                          <LoadingSpinner />
                        </div>
                      )}
                      {shareMutation.isError && (
                        <Alert variant="error">{getErrorMessage(shareMutation.error)}</Alert>
                      )}
                      {share && (
                        <div className="space-y-2">
                          <div className="flex gap-2">
                            <input
                              type="text"
                              readOnly
                              value={share.url}
                              aria-label={t('plants.share.title')}
                              className="input flex-1 text-sm"
                              onFocus={(e) => e.currentTarget.select()}
                            />
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={handleCopy}
                              leftIcon={
                                copied ? (
                                  <CheckIcon className="h-4 w-4" aria-hidden="true" />
                                ) : (
                                  <ClipboardDocumentIcon className="h-4 w-4" aria-hidden="true" />
                                )
                              }
                            >
                              {copied ? t('plants.share.copied') : t('plants.share.copy')}
                            </Button>
                          </div>
                          {copyError && (
                            <p className="text-xs text-red-600">{t('plants.share.copyFailed')}</p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mt-5 sm:mt-4 sm:flex sm:flex-row-reverse">
                  <Button variant="secondary" onClick={onClose}>
                    {t('common.close')}
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
