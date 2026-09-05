import { useQuery } from '@tanstack/react-query';
import { ExclamationTriangleIcon, InformationCircleIcon } from '@heroicons/react/24/outline';
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

/**
 * Gentle placement checks based only on explicit space and species data.
 *
 * The card carries a pet check — "this species may be toxic, and this room is
 * marked as reachable by pets" — so its absence is a claim, not a silence.
 * The species side of both checks comes either from the small curated table
 * (`findCareGuide`) or, for everything else, from the `/species/:id/guide`
 * read. A FAILED read used to leave `enriched` undefined, which collapsed both
 * checks to nothing and returned null: identical on screen to "this placement
 * is fine". That is the same defect #350 fixed in `CareGuideCard`, and it
 * survived here because the guard is `checks.length === 0` rather than
 * `if (!data)`, which is the shape `reads:check` looks for. See ADR 0010.
 *
 * Three read states, kept distinct:
 *   - in flight — render nothing; an unsettled read is not an answer;
 *   - settled with no data — the read failed. When there is no curated
 *     fallback, nothing was checked, and the card says so rather than
 *     vanishing;
 *   - settled — the checks are real, and so is an empty list of them.
 *
 * A provider `null` (species enriched, no guide published) is deliberately NOT
 * treated as a failure: it is the provider answering, and `PetToxicityNote`
 * already states that unknown-toxicity case on this same page.
 */
export function PlacementFitCard({ space, species, perenualSpeciesId }: PlacementFitCardProps) {
  const { t } = useTranslation();
  const curated = findCareGuide(species);
  const enrichmentEnabled = Boolean(space && perenualSpeciesId);
  const { data: enriched, isLoading } = useQuery({
    queryKey: ['species', 'guide', perenualSpeciesId],
    queryFn: () => speciesService.careGuide(perenualSpeciesId!),
    enabled: enrichmentEnabled,
    staleTime: 60 * 60 * 1000,
  });

  const checks = placementFitChecks(space, {
    minimumLight: curated?.minimumLight ?? minimumLightFromSunlight(enriched?.sunlight ?? []),
    toxicToPets: enriched?.poisonousToPets ?? curated?.toxicToPets,
  });

  // `CareGuide` carries both `minimumLight` and `toxicToPets` as required
  // fields, so a curated hit answers each check on its own and a failed
  // enrichment read costs nothing. Without one, that read was the only source
  // for both.
  const unchecked = enrichmentEnabled && !isLoading && enriched === undefined && !curated;

  if (!space) return null;
  if (enrichmentEnabled && isLoading) return null;
  if (checks.length === 0 && !unchecked) return null;

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
        {unchecked && (
          <li className="flex items-start gap-2 text-sm text-amber-950">
            <InformationCircleIcon
              className="mt-0.5 h-5 w-5 flex-none text-amber-700"
              aria-hidden="true"
            />
            <span>{t('placementFit.unchecked', { space: space.name })}</span>
          </li>
        )}
      </ul>
    </Card>
  );
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
