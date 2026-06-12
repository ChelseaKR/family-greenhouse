import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { plantService } from '@/services/plantService';
import { getErrorMessage } from '@/services/api';
import { downscaleImage } from '@/utils/image';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

interface PlantImageUploadProps {
  plantId: string;
}

export function PlantImageUpload({ plantId }: PlantImageUploadProps) {
  const queryClient = useQueryClient();
  const householdId = useActiveHouseholdId();
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      // Downscale client-side (max 1600px long edge, WebP ~0.8 with JPEG
      // fallback). If the canvas pipeline fails we degrade gracefully and
      // upload the original — the 5 MiB guard below applies to whichever
      // blob actually goes over the wire (the backend confirm step enforces
      // the same limit server-side).
      const downscaled = await downscaleImage(file);
      const blob: Blob = downscaled && ACCEPTED_TYPES.includes(downscaled.type) ? downscaled : file;
      if (blob.size > MAX_BYTES) {
        throw new Error(`Image is too large (max ${MAX_BYTES / 1024 / 1024} MB).`);
      }
      // The presign request carries the blob's content type, and the PUT
      // must use the exact same Content-Type header (backend contract).
      const contentType = blob.type || file.type;
      const { uploadUrl, imageUrl } = await plantService.getImageUploadUrl(plantId, contentType);
      await plantService.uploadImage(uploadUrl, blob, contentType, setProgress);
      await plantService.confirmImageUpload(plantId, imageUrl);
      return imageUrl;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plants', householdId, plantId] });
      queryClient.invalidateQueries({ queryKey: ['plants', householdId] });
      setProgress(0);
    },
    onError: (err) => {
      setError(getErrorMessage(err));
      setProgress(0);
    },
  });

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError('Image must be a JPEG, PNG, or WebP file.');
      return;
    }
    // No pre-downscale size check: a 12 MB camera original usually shrinks
    // well under the limit. The final blob is guarded in the mutation.
    upload.mutate(file);
  }

  return (
    <div className="space-y-3">
      {error && <Alert variant="error">{error}</Alert>}
      {/* max-w-full: <input type="file"> has a large intrinsic min-width in
          Chrome, which otherwise overflows narrow containers/viewports. */}
      <label className="block max-w-full">
        <span className="sr-only">Upload plant photo</span>
        <input
          type="file"
          accept={ACCEPTED_TYPES.join(',')}
          onChange={onPick}
          disabled={upload.isPending}
          className="block w-full max-w-full text-sm file:mr-4 file:rounded-md file:border-0 file:bg-primary-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary-700 hover:file:bg-primary-100"
        />
      </label>
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
      {upload.isError && (
        <Button variant="secondary" size="sm" onClick={() => upload.reset()}>
          Try again
        </Button>
      )}
    </div>
  );
}
