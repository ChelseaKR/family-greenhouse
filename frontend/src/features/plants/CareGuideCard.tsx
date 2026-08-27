import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { Card, CardHeader } from '@/components/Card';
import { speciesService } from '@/services/speciesService';

interface CareGuideCardProps {
  perenualSpeciesId: number;
}

const sectionLabels: Record<'watering' | 'sunlight' | 'pruning', string> = {
  watering: 'Watering',
  sunlight: 'Sunlight',
  pruning: 'Pruning',
};

/**
 * Long-form care guide for a plant whose species we've enriched via
 * Perenual.
 *
 * This card no longer carries the pet-toxicity callout. It used to be the
 * only place `PlantDetailPage` showed toxicity, while `if (isLoading || !data)
 * return null` discarded a failed guide fetch in silence — so a Perenual
 * outage removed the one fact the old docstring called "actively dangerous to
 * miss", and removed it in a way indistinguishable from "this species has no
 * guide". A safety-relevant fact must not ride on the same fetch as
 * decorative prose, so toxicity moved to `PetToxicityNote`, which is mounted
 * independently by `PlantDetailPage` and states "couldn't check" and
 * "unknown" as their own outcomes.
 *
 * What remains here is informational, and its three read states are still
 * distinct: still in flight renders nothing (an unsettled read is not an
 * answer), a settled read with no data says the guide could not be loaded,
 * and a genuine `null` (species enriched, no guide published) renders
 * nothing. See ADR 0010.
 */
export function CareGuideCard({ perenualSpeciesId }: CareGuideCardProps) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['species', 'guide', perenualSpeciesId],
    queryFn: () => speciesService.careGuide(perenualSpeciesId),
    staleTime: 60 * 60 * 1000,
  });

  if (isLoading) return null;

  // Settled with no data at all = the read failed. `null` is different: it is
  // the provider answering "no guide for this species", which is a real empty.
  if (data === undefined) {
    return (
      <Card>
        <div className="flex items-start gap-2 text-sm text-gray-700">
          <ExclamationTriangleIcon
            className="mt-0.5 h-4 w-4 flex-none text-gray-500"
            aria-hidden="true"
          />
          <p>
            <span className="font-semibold text-gray-900">
              {t('plants.careGuide.unavailableTitle')}
            </span>{' '}
            {t('plants.careGuide.unavailableBody')}
          </p>
        </div>
      </Card>
    );
  }

  if (data === null) return null;

  return (
    <Card>
      <CardHeader
        title="Care guide"
        description={
          data.commonName !== data.scientificName
            ? `${data.commonName} · ${data.scientificName}`
            : data.scientificName
        }
      />

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6 text-sm">
        {data.family && <Stat label="Family" value={data.family} />}
        {data.cycle && <Stat label="Cycle" value={data.cycle} />}
        {data.hardinessZone && <Stat label="Hardiness zones" value={data.hardinessZone} />}
        {data.sunlight.length > 0 && <Stat label="Sunlight" value={data.sunlight.join(', ')} />}
      </dl>

      {data.sections.length === 0 ? (
        <p className="text-sm text-gray-500">No care guide available for this species yet.</p>
      ) : (
        <div className="space-y-4">
          {data.sections.map((s) => (
            <section key={s.type}>
              <h4 className="text-sm font-semibold text-gray-900">{sectionLabels[s.type]}</h4>
              <p className="mt-1 text-sm text-gray-700 whitespace-pre-line">{s.description}</p>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-gray-600">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-gray-900">{value}</dd>
    </div>
  );
}
