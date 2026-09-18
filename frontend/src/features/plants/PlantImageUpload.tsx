import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PhotoIcon } from '@heroicons/react/24/outline';
import clsx from 'clsx';
import { plantService } from '@/services/plantService';
import { getErrorMessage } from '@/services/api';
import { prepareImageForUpload } from '@/utils/image';
import { ImageMetadataError } from '@/utils/imageMetadata';
import { canUseNativeCamera } from '@/services/nativeCamera';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { NativePhotoButtons } from '@/components/NativePhotoButtons';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

interface PlantImageUploadProps {
  plantId: string;
  onUploadSuccess?: () => void;
}

export function PlantImageUpload({ plantId, onUploadSuccess }: PlantImageUploadProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const householdId = useActiveHouseholdId();
  const native = canUseNativeCamera();
  const inputId = useId();
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
        throw new Error(`Image is too large (max ${MAX_BYTES / 1024 / 1024} MB).`);
      }
      // The presign request carries the blob's content type, and the PUT
      // must use the exact same Content-Type header (backend contract). The
      // type is read from the bytes, not from the file name.
      const contentType = blob.type;
      const { uploadUrl, imageUrl } = await plantService.getImageUploadUrl(plantId, contentType);
      await plantService.uploadImage(uploadUrl, blob, contentType, setProgress, signal);
      // Don't confirm an upload the user already navigated away from.
      if (signal.aborted) throw new DOMException('Upload aborted', 'AbortError');
      await plantService.confirmImageUpload(plantId, imageUrl);
      return imageUrl;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plants', householdId, plantId] });
      queryClient.invalidateQueries({ queryKey: ['plants', householdId] });
      setProgress(0);
      setLastFile(null);
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
    upload.mutate(file);
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError('Image must be a JPEG, PNG, or WebP file.');
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

  return (
    <div className="space-y-3">
      {error && <Alert variant="error">{error}</Alert>}
      {native ? (
        <NativePhotoButtons onPick={onNativePick} onError={setError} disabled={upload.isPending} />
      ) : (
        <div>
          <input
            id={inputId}
            type="file"
            accept={ACCEPTED_TYPES.join(',')}
            onChange={onPick}
            disabled={upload.isPending}
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
            {upload.isPending ? 'Uploading photo…' : 'Upload photo'}
          </label>
          <p className="mt-1 text-xs text-gray-600">
            JPEG, PNG, or WebP. Up to 5 MB after resizing.
          </p>
        </div>
      )}
      {upload.isPending && (
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-gray-200"
          role="progressbar"
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
          Try again
        </Button>
      )}
    </div>
  );
}
