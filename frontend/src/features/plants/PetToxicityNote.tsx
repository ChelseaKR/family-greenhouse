import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { speciesService } from '@/services/speciesService';
import { Alert } from '@/components/Alert';

interface PetToxicityNoteProps {
  perenualSpeciesId: number | null;
  /**
   * Which surface is asking. `add` (the default) is the AddPlant form, where
   * the note ends with a reassurance that a toxic species can still be saved.
   * `owned` is a plant already living in the household, where that sentence
   * would be nonsense — only the placement advice applies. Every other state's
   * copy is context-neutral and shared.
   */
  context?: 'add' | 'owned';
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
 * Confirmed non-toxic (`poisonousToPets === false`) renders nothing. Every
 * unknown state is conservative: provider unavailability gets a retryable
 * "couldn't check" notice, while a real no-result or null toxicity field gets
 * an "unknown" notice. Neither can silently resemble confirmed-safe.
 *
 * `PlantDetailPage` mounts this too (`context="owned"`). Toxicity used to be
 * shown there only inside `CareGuideCard`, whose failed fetch dropped it
 * silently; carrying it on its own query means an outage in the long-form
 * guide can no longer take the safety fact with it. See ADR 0010.
 */
export function PetToxicityNote({ perenualSpeciesId, context = 'add' }: PetToxicityNoteProps) {
  const { t } = useTranslation();
  const { data, isError } = useQuery({
    queryKey: ['species', 'detail', perenualSpeciesId],
    queryFn: () => speciesService.detailLookup(perenualSpeciesId!),
    enabled: !!perenualSpeciesId,
    // Found/not-found data mirrors the one-hour HTTP cache. An unavailable
    // result is deliberately stale immediately so a remount/window focus can
    // recover instead of preserving a transient outage for an hour.
    staleTime: (query) => (query.state.data?.status === 'unavailable' ? 0 : 60 * 60 * 1000),
    // One selection should spend at most one backend request. Budget/upstream
    // recovery happens on a later focus/remount, not an automatic retry burst.
    retry: false,
  });

  if (!perenualSpeciesId) return null;

  if (isError || data?.status === 'unavailable') {
    return (
      <Alert variant="info" title={t('plants.petToxicity.unavailableTitle')}>
        {t('plants.petToxicity.unavailableBody')}
      </Alert>
    );
  }

  if (
    data?.status === 'not_found' ||
    (data?.status === 'found' && data.result.poisonousToPets === null)
  ) {
    return (
      <Alert variant="info" title={t('plants.petToxicity.unknownTitle')}>
        {t('plants.petToxicity.unknownBody')}
      </Alert>
    );
  }

  if (data?.status !== 'found' || data.result.poisonousToPets !== true) return null;

  return (
    <Alert variant="warning" title={t('plants.petToxicity.toxicTitle')}>
      {context === 'owned'
        ? t('plants.petToxicity.toxicBodyOwned')
        : t('plants.petToxicity.toxicBody')}
    </Alert>
  );
}
