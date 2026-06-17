import { useQuery } from '@tanstack/react-query';
import { speciesService } from '@/services/speciesService';
import { Alert } from '@/components/Alert';

interface PetToxicityNoteProps {
  perenualSpeciesId: number | null;
}

/**
 * Inline heads-up shown on the AddPlant form once the user picks a Perenual-
 * backed species that's flagged toxic to pets. Sourced from the same species
 * detail the form already keys on (`perenualSpeciesId`) — no extra backend
 * surface, just the existing `/species/:id` lookup. If the detail fails or
 * the species isn't flagged toxic, we render nothing.
 *
 * This is informational only: it never blocks saving. Plenty of people keep
 * toxic plants on purpose and just place them out of reach — the note is a
 * gentle heads-up, not a gate.
 */
export function PetToxicityNote({ perenualSpeciesId }: PetToxicityNoteProps) {
  const { data } = useQuery({
    queryKey: ['species', 'detail', perenualSpeciesId],
    queryFn: () => speciesService.detail(perenualSpeciesId!),
    enabled: !!perenualSpeciesId,
    staleTime: 60 * 60 * 1000,
  });

  if (!data?.poisonousToPets) return null;

  return (
    <Alert variant="warning" title="Toxic to pets">
      Toxic to cats and dogs if chewed — keep it out of reach. You can still add it; this is just a
      heads-up.
    </Alert>
  );
}
