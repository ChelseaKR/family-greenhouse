import { Fragment, useRef, useState } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SparklesIcon, PhotoIcon } from '@heroicons/react/24/outline';
import clsx from 'clsx';
import { plantService, LeafHealthResult, LeafHealthObservation } from '@/services/plantService';
import { Button } from '@/components/Button';
import { Alert } from '@/components/Alert';
import { getErrorMessage } from '@/services/api';
import { downscaleImage } from '@/utils/image';

interface LeafHealthCardProps {
  plantId: string;
  isOpen: boolean;
  onClose: () => void;
}

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// The backend body cap is 256 KiB of base64 (~190 KiB binary). Downscaling a
// leaf close-up to 1024px lands far under that while keeping enough detail
// for "is this yellowing?".
const LEAF_PHOTO_MAX_EDGE = 1024;
const MAX_BASE64_CHARS = 350_000;

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Badge styling per overall verdict — green / amber / red. */
const OVERALL_STYLES: Record<LeafHealthResult['overall'], string> = {
  healthy: 'bg-green-100 text-green-800 ring-green-200',
  monitor: 'bg-amber-100 text-amber-800 ring-amber-200',
  concern: 'bg-red-100 text-red-800 ring-red-200',
};

const CONFIDENCE_STYLES: Record<LeafHealthObservation['confidence'], string> = {
  low: 'bg-gray-100 text-gray-600',
  medium: 'bg-amber-50 text-amber-700',
  high: 'bg-amber-100 text-amber-900',
};

/**
 * Results card — exported separately so it can be rendered (and tested)
 * without the dialog/photo-picking chrome.
 */
export function LeafHealthResults({ result }: { result: LeafHealthResult }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 text-left" data-testid="leaf-health-results">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-500">
          {t('plants.leafHealth.overallLabel')}
        </span>
        <span
          className={clsx(
            'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1',
            OVERALL_STYLES[result.overall]
          )}
        >
          {t(`plants.leafHealth.overall.${result.overall}`)}
        </span>
      </div>

      <div>
        <h4 className="text-sm font-medium text-gray-900">
          {t('plants.leafHealth.observationsTitle')}
        </h4>
        {result.observations.length === 0 ? (
          <p className="mt-1 text-sm text-gray-600">{t('plants.leafHealth.noObservations')}</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {result.observations.map((obs, i) => (
              <li key={`${obs.sign}-${i}`} className="rounded-md bg-gray-50 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-gray-900">{obs.sign}</span>
                  <span
                    className={clsx(
                      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                      CONFIDENCE_STYLES[obs.confidence]
                    )}
                  >
                    {t(`plants.leafHealth.confidence.${obs.confidence}`)}
                  </span>
                </div>
                <p className="mt-1 text-sm text-gray-600">{obs.note}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="text-sm font-medium text-gray-900">
          {t('plants.leafHealth.suggestionTitle')}
        </h4>
        <p className="mt-1 text-sm text-gray-600">{result.suggestion}</p>
      </div>

      {result.demo && <p className="text-xs text-amber-700">{t('plants.leafHealth.demoNotice')}</p>}

      <p className="text-xs text-gray-400">{result.disclaimer}</p>
    </div>
  );
}

/**
 * "Check leaf health" dialog: pick/capture a leaf close-up, downscale it
 * client-side (BEFORE base64 — the endpoint shares identify's 256 KiB body
 * cap), and render the strict visual assessment that comes back.
 */
export function LeafHealthCard({ plantId, isOpen, onClose }: LeafHealthCardProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  const checkMutation = useMutation({
    mutationFn: (imageBase64: string) => plantService.checkLeafHealth(plantId, imageBase64),
  });

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setPickError(null);
    checkMutation.reset();
    const file = e.target.files?.[0];
    // Allow re-picking the same file.
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setPickError(t('plants.leafHealth.notAnImage'));
      return;
    }
    try {
      // Downscale BEFORE encoding; fall back to the original only when the
      // canvas pipeline is unavailable AND the original is small enough.
      const downscaled = await downscaleImage(file, LEAF_PHOTO_MAX_EDGE);
      const blob: Blob = downscaled && ACCEPTED_TYPES.includes(downscaled.type) ? downscaled : file;
      const dataUrl = await blobToDataUrl(blob);
      if (dataUrl.length > MAX_BASE64_CHARS) {
        setPickError(t('plants.leafHealth.tooLarge'));
        return;
      }
      setPreview(dataUrl);
    } catch {
      setPickError(t('plants.leafHealth.readFailed'));
    }
  };

  const handleClose = () => {
    setPreview(null);
    setPickError(null);
    checkMutation.reset();
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
                <div className="sm:flex sm:items-start">
                  <div className="mx-auto flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-primary-100 sm:mx-0 sm:h-10 sm:w-10">
                    <SparklesIcon className="h-6 w-6 text-primary-700" aria-hidden="true" />
                  </div>
                  <div className="mt-3 w-full text-center sm:ml-4 sm:mt-0 sm:text-left">
                    <Dialog.Title
                      as="h3"
                      className="font-serif text-xl font-semibold leading-tight tracking-tight text-gray-900"
                    >
                      {t('plants.leafHealth.title')}
                    </Dialog.Title>
                    <p className="mt-2 text-sm leading-relaxed text-gray-600">
                      {t('plants.leafHealth.description')}
                    </p>

                    <div className="mt-4 space-y-4">
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        onChange={handleFilePick}
                        aria-label={t('plants.leafHealth.pickPhoto')}
                      />

                      {preview && (
                        <img
                          src={preview}
                          alt={t('plants.leafHealth.previewAlt')}
                          className="mx-auto max-h-48 rounded-md object-contain"
                        />
                      )}

                      <div className="flex flex-wrap justify-center gap-2 sm:justify-start">
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => fileInputRef.current?.click()}
                          leftIcon={<PhotoIcon className="h-4 w-4" aria-hidden="true" />}
                        >
                          {preview
                            ? t('plants.leafHealth.retake')
                            : t('plants.leafHealth.pickPhoto')}
                        </Button>
                        {preview && (
                          <Button
                            type="button"
                            onClick={() => checkMutation.mutate(preview)}
                            isLoading={checkMutation.isPending}
                            leftIcon={<SparklesIcon className="h-4 w-4" aria-hidden="true" />}
                          >
                            {checkMutation.isPending
                              ? t('plants.leafHealth.analyzing')
                              : t('plants.leafHealth.analyze')}
                          </Button>
                        )}
                      </div>

                      {pickError && <Alert variant="error">{pickError}</Alert>}
                      {checkMutation.isError && (
                        <Alert variant="error">{getErrorMessage(checkMutation.error)}</Alert>
                      )}
                      {checkMutation.data && <LeafHealthResults result={checkMutation.data} />}
                    </div>
                  </div>
                </div>
                <div className="mt-5 sm:mt-4 sm:flex sm:flex-row-reverse">
                  <Button variant="secondary" onClick={handleClose}>
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
