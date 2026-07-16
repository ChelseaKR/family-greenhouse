import { useQuery } from '@tanstack/react-query';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import type { PlantSpace } from '@/services/plantService';
import { speciesService } from '@/services/speciesService';
import { Card, CardHeader } from '@/components/Card';
import { findCareGuide } from '@/utils/careGuidance';
import { minimumLightFromSunlight, placementFitChecks } from './placementFit';

interface PlacementFitCardProps {
  space: PlantSpace | null | undefined;
  species: string | null | undefined;
  perenualSpeciesId: number | null | undefined;
}

/** Gentle placement checks based only on explicit space and species data. */
export function PlacementFitCard({ space, species, perenualSpeciesId }: PlacementFitCardProps) {
  const { t } = useTranslation();
  const curated = findCareGuide(species);
  const { data: enriched } = useQuery({
    queryKey: ['species', 'guide', perenualSpeciesId],
    queryFn: () => speciesService.careGuide(perenualSpeciesId!),
    enabled: Boolean(space && perenualSpeciesId),
    staleTime: 60 * 60 * 1000,
  });

  const checks = placementFitChecks(space, {
    minimumLight: curated?.minimumLight ?? minimumLightFromSunlight(enriched?.sunlight ?? []),
    toxicToPets: enriched?.poisonousToPets ?? curated?.toxicToPets,
  });
  if (!space || checks.length === 0) return null;

  return (
    <Card variant="paper" className="ring-1 ring-inset ring-amber-200/80">
      <CardHeader
        title={t('placementFit.title')}
        description={t('placementFit.description', { space: space.name })}
      />
      <ul className="space-y-3">
        {checks.map((check) => (
          <li key={check.type} className="flex items-start gap-2 text-sm text-amber-950">
            <ExclamationTriangleIcon
              className="mt-0.5 h-5 w-5 flex-none text-amber-700"
              aria-hidden="true"
            />
            <span>
              {check.type === 'light'
                ? t('placementFit.lightCheck', {
                    space: space.name,
                    current: t(`spaces.light${capitalize(check.current)}`),
                    recommended: t(`spaces.light${capitalize(check.recommended)}`),
                  })
                : t('placementFit.petCheck', { space: space.name })}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
