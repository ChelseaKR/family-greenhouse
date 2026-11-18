import { useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PhotoIcon } from '@heroicons/react/24/outline';
import clsx from 'clsx';
import { plantService } from '@/services/plantService';
import { getErrorMessage } from '@/services/api';
import { prepareImageForUpload } from '@/utils/image';
import { ImageMetadataError } from '@/utils/imageMetadata';
import {
  canUseNativeCamera,
  nativePhotoErrorMessage,
  pickNativePhoto,
  type PhotoSource,
} from '@/services/nativeCamera';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { NativePhotoButtons } from '@/components/NativePhotoButtons';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Opens the camera or the photo library from elsewhere (a menu item). */
export interface PhotoPicker {
  pick: (source: PhotoSource) => void;
}

interface PlantImageUploadProps {
  plantId: string;
  onUploadSuccess?: () => void;
  /** Hide the pick buttons (the page offers them in a menu, through
   *  `picker`); progress, errors and Try again still show here. */
  buttonsHidden?: boolean;
  picker?: Ref<PhotoPicker>;
}

export function PlantImageUpload({
  plantId,
  onUploadSuccess,
  buttonsHidden = false,
  picker,
}: PlantImageUploadProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const householdId = useActiveHouseholdId();
  const native = canUseNativeCamera();
  const inputId = useId();
  // What the polite status region says once an upload has finished. Empty
  // until then, and cleared when the next one starts.
  const [doneMessage, setDoneMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [lastFile, setLastFile] = useState<File | null>(null);
  // Cancels an in-flight upload when the component unmounts (navigating away
  // mid-upload) so the PUT is aborted and the confirm step never fires for an
  // abandoned upload.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      abortRef.current?.abort(); // cancel any prior in-flight upload
      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;
      // Downscale client-side (max 1600px long edge, WebP ~0.8 with JPEG
      // fallback) and remove the photo's metadata, GPS included. If the
      // canvas pipeline fails the original is uploaded instead, still
      // stripped; a photo whose metadata cannot be removed is not uploaded.
      // The 5 MiB guard applies to the blob that actually goes over the wire
      // (the backend confirm step enforces the same limit server-side).
      const blob = await prepareImageForUpload(file);
      if (blob.size > MAX_BYTES) {
        throw new Error(t('plants.photoUpload.tooLarge', { max: MAX_BYTES / 1024 / 1024 }));
      }
      // The presign request carries the blob's content type and size, and
      // the PUT must send exactly that Content-Type and that many bytes
      // (backend contract). The type is read from the bytes, not from the
      // file name.
      const contentType = blob.type;
      const { uploadUrl, imageUrl } = await plantService.getImageUploadUrl(
        plantId,
        contentType,
        blob.size
      );
      await plantService.uploadImage(uploadUrl, blob, contentType, setProgress, signal);
      // Don't confirm an upload the user already navigated away from.
      if (signal.aborted) throw new DOMException('Upload aborted', 'AbortError');
      // `imageUrl` only names the upload. The photo the plant shows is the
      // server's own copy, which the queries invalidated below fetch.
      await plantService.confirmImageUpload(plantId, imageUrl);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plants', householdId, plantId] });
      queryClient.invalidateQueries({ queryKey: ['plants', householdId] });
      setProgress(0);
      setLastFile(null);
      setDoneMessage(t('caretaker.page.photoAdded'));
      onUploadSuccess?.();
    },
    onError: (err) => {
      // A cancelled upload (unmount, or a newer upload superseding this one)
      // isn't a failure to surface.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(
        err instanceof ImageMetadataError
          ? t('plants.photoPicker.prepareFailed')
          : getErrorMessage(err)
      );
      setProgress(0);
    },
  });

  function start(file: File) {
    // No pre-downscale size check: a 12 MB camera original usually shrinks
    // well under the limit. The final blob is guarded in the mutation.
    setLastFile(file);
    setDoneMessage('');
    upload.mutate(file);
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    const file = e.target.files?.[0];
    if (!file || upload.isPending) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError(t('plants.photoUpload.wrongType'));
      e.target.value = '';
      return;
    }
    start(file);
    // Allow choosing the same photo again after an error.
    e.target.value = '';
  }

  // The native camera and picker hand over whatever the phone stores (HEIC
  // included on iOS), so their photos skip the extension check above and go
  // straight to prepareImageForUpload(), which re-encodes what the WebView
  // can decode and refuses what it cannot strip.
  function onNativePick(file: File) {
    setError(null);
    start(file);
  }

  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(picker, () => ({
    pick: (source) => {
      if (upload.isPending) return;
      if (native) {
        setError(null);
        pickNativePhoto(source)
          .then((file) => file && onNativePick(file))
          .catch((err: unknown) => setError(nativePhotoErrorMessage(err, t)));
        return;
      }
      const input = inputRef.current;
      if (!input) return;
      // "Take photo" asks a phone browser for the camera; "Choose photo" for
      // the library. Desktop browsers ignore `capture`.
      if (source === 'camera') input.setAttribute('capture', 'environment');
      else input.removeAttribute('capture');
      input.click();
    },
  }));

  return (
    <div className="space-y-3">
      {error && <Alert variant="error">{error}</Alert>}
      {buttonsHidden && !native ? (
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_TYPES.join(',')}
          onChange={onPick}
          disabled={upload.isPending}
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
        />
      ) : buttonsHidden ? null : native ? (
        <NativePhotoButtons onPick={onNativePick} onError={setError} disabled={upload.isPending} />
      ) : (
        <div>
          {/* aria-disabled, not disabled, while a photo is uploading. A
              disabled control cannot hold focus: someone who chose the file
              with the keyboard was dropped to the top of the document the
              moment the upload began, and had to Tab back down the whole page
              (WCAG 2.4.3). The click is refused instead, so the picker still
              cannot open twice. */}
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={ACCEPTED_TYPES.join(',')}
            onChange={onPick}
            onClick={(e) => {
              if (upload.isPending) e.preventDefault();
            }}
            aria-disabled={upload.isPending || undefined}
            className="peer sr-only"
          />
          <label
            htmlFor={inputId}
            className={clsx(
              'inline-flex min-h-touch w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-primary-300/70 bg-paper px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-primary-50',
              'peer-focus-visible:ring-2 peer-focus-visible:ring-primary-500 peer-focus-visible:ring-offset-2',
              upload.isPending && 'cursor-wait opacity-50'
            )}
          >
            <PhotoIcon className="h-4 w-4" aria-hidden="true" />
            {upload.isPending ? t('plants.photoUpload.uploading') : t('plants.photoUpload.upload')}
          </label>
          <p className="mt-1 text-xs text-gray-600">{t('plants.photoUpload.formats')}</p>
        </div>
      )}
      {/* Always in the document, so it is a live region before it has anything
          to say. Without it the upload started and finished in silence: the
          label's text changed and a photo appeared, and neither is announced
          (WCAG 4.1.3). Failures are announced by the Alert above. */}
      <p className="sr-only" role="status">
        {upload.isPending ? t('caretaker.page.photoUploading') : doneMessage}
      </p>
      {upload.isPending && (
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-gray-200"
          role="progressbar"
          // A progressbar with no name is announced as a bare percentage.
          aria-label={t('caretaker.page.photoUploading')}
          aria-valuenow={Math.round(progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full bg-primary-500 transition-[width]"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      )}
      {upload.isError && lastFile && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setError(null);
            upload.mutate(lastFile);
          }}
        >
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}
