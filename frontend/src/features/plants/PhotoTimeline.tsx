import { useQuery } from '@tanstack/react-query';
import { plantService } from '@/services/plantService';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { LoadingSpinner } from '@/components/LoadingSpinner';

interface PhotoTimelineProps {
  plantId: string;
}

/**
 * Horizontal scroll strip of every photo a plant has accumulated, newest
 * first. Hides itself entirely when there's ≤1 photo (the main image
 * already shows the latest, so a one-item timeline would be visual noise).
 */
export function PhotoTimeline({ plantId }: PhotoTimelineProps) {
  const householdId = useActiveHouseholdId();
  const { data: photos, isLoading } = useQuery({
    queryKey: ['plants', householdId, plantId, 'photos'],
    queryFn: () => plantService.listPhotos(plantId),
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <LoadingSpinner size="sm" />
        Loading photos…
      </div>
    );
  }
  if (!photos || photos.length <= 1) return null;

  return (
    <section aria-label="Photo timeline">
      <h2 className="text-sm font-semibold text-gray-900 mb-2">Photo timeline</h2>
      <ul className="flex gap-3 overflow-x-auto pb-2">
        {photos.map((photo) => (
          <li key={photo.id} className="flex-shrink-0">
            <figure className="w-32">
              <img
                src={photo.imageUrl}
                alt={
                  photo.caption ?? `Photo from ${new Date(photo.uploadedAt).toLocaleDateString()}`
                }
                width={128}
                height={128}
                loading="lazy"
                decoding="async"
                className="h-32 w-32 rounded-md object-cover bg-gray-100"
              />
              <figcaption className="mt-1 text-xs text-gray-600">
                {new Date(photo.uploadedAt).toLocaleDateString()}
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
    </section>
  );
}
