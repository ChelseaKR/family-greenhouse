import { useQuery } from '@tanstack/react-query';
import { speciesService } from '@/services/speciesService';

interface SuggestedCareCardProps {
  perenualSpeciesId: number | null;
  /** The add flow may use a richer curated bundle instead of this fallback. */
  showWateringTaskNotice: boolean;
}

/**
 * Inline card shown on the AddPlant form once the user picks a Perenual-
 * backed species. Loads the care suggestion in the background — if it
 * fails or returns null (Perenual disabled, budget exhausted, no data) we
 * just don't render. The card is purely informational at the form stage;
 * the watering task is created from the suggestion *after* the plant is
 * saved (see AddPlantPage.applySuggestedSchedule).
 */
export function SuggestedCareCard({
  perenualSpeciesId,
  showWateringTaskNotice,
}: SuggestedCareCardProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['species', 'care-suggestions', perenualSpeciesId],
    queryFn: () => speciesService.careSuggestions(perenualSpeciesId!),
    enabled: !!perenualSpeciesId,
    staleTime: 60 * 60 * 1000,
  });

  if (!perenualSpeciesId || isLoading || !data) return null;

  return (
    <div
      className="rounded-lg border border-primary-200 bg-primary-50 p-4 text-sm"
      aria-label="Suggested care"
    >
      <p className="font-semibold text-primary-900">Suggested care</p>
      <p className="mt-1 text-primary-900">{data.summary}</p>
      {showWateringTaskNotice && data.wateringDays !== null && (
        <p className="mt-2 text-xs text-primary-700">
          We&rsquo;ll create a watering task on a {data.wateringDays}-day cadence after you save
          this plant. You can edit it any time.
        </p>
      )}
    </div>
  );
}
