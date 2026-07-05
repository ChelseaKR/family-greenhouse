import { useQuery } from '@tanstack/react-query';
import { speciesService } from '@/services/speciesService';
import { Alert } from '@/components/Alert';

interface PetToxicityNoteProps {
  perenualSpeciesId: number | null;
}

/**
 * Inline heads-up shown on the AddPlant form once the user picks a Perenual-
 * backed species. Sourced from the same species detail the form already keys
 * on (`perenualSpeciesId`) — no extra backend surface, just the existing
 * `/species/:id` lookup.
 *
 * This is informational only: it never blocks saving. Plenty of people keep
 * toxic plants on purpose and just place them out of reach — the note is a
 * gentle heads-up, not a gate.
 *
 * Three distinct "nothing to warn about" states are NOT treated the same:
 * confirmed non-toxic (`poisonousToPets === false`) renders nothing, same as
 * before; a genuine fetch failure renders a small "couldn't check" notice
 * rather than silently looking identical to "confirmed safe" — this is the
 * one card in the app where that absence is actively dangerous to get wrong.
 * Perenual having no toxicity data at all (`poisonousToPets === null`) also
 * renders nothing, matching this app's "say nothing rather than guess"
 * convention — it does not assert safety, it just has no warning to show.
 */
export function PetToxicityNote({ perenualSpeciesId }: PetToxicityNoteProps) {
  const { data, isError } = useQuery({
    queryKey: ['species', 'detail', perenualSpeciesId],
    queryFn: () => speciesService.detail(perenualSpeciesId!),
    enabled: !!perenualSpeciesId,
    staleTime: 60 * 60 * 1000,
  });

  if (!perenualSpeciesId) return null;

  if (isError) {
    return (
      <Alert variant="info" title="Couldn't check pet toxicity">
        We couldn&rsquo;t look up pet-safety data for this species just now. If you have pets,
        it&rsquo;s worth checking the ASPCA&rsquo;s plant list before deciding where to put it.
      </Alert>
    );
  }

  if (data?.poisonousToPets !== true) return null;

  return (
    <Alert variant="warning" title="Toxic to pets">
      Toxic to cats and dogs if chewed — keep it out of reach. You can still add it; this is just a
      heads-up.
    </Alert>
  );
}
