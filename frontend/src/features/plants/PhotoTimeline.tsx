import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { plantService } from '@/services/plantService';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { useRefreshSignedPhotos } from '@/hooks/useRefreshSignedPhotos';
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
  const { t } = useTranslation();
  const householdId = useActiveHouseholdId();
  const refreshSignedPhotos = useRefreshSignedPhotos();
  const headingId = useId();
  const { data: photos, isLoading } = useQuery({
    queryKey: ['plants', householdId, plantId, 'photos'],
    queryFn: () => plantService.listPhotos(plantId),
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <LoadingSpinner size="sm" />
        {t('plants.photoTimeline.loading')}
      </div>
    );
  }
  if (!photos || photos.length <= 1) return null;

  return (
    <section aria-label={t('plants.photoTimeline.title')}>
      <h2 id={headingId} className="text-sm font-semibold text-ink mb-2">
        {t('plants.photoTimeline.title')}
      </h2>
      {/* tabIndex 0: the strip scrolls sideways and holds nothing focusable,
          so without a tab stop a keyboard user could not reach the photos
          past the first few (WCAG 2.1.1; axe scrollable-region-focusable).
          Focused, the arrow keys scroll it. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be focusable to be scrolled from the keyboard */}
      <ul className="flex gap-3 overflow-x-auto pb-2" tabIndex={0} aria-labelledby={headingId}>
        {photos.map((photo) => (
          <li key={photo.id} className="shrink-0">
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
                className="h-32 w-32 rounded-md object-cover bg-parchment"
                onError={refreshSignedPhotos}
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
