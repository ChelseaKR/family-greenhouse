import { useQuery } from '@tanstack/react-query';
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
 * Perenual. Renders nothing when the species isn't enriched or the guide
 * fetch fails, so the page degrades cleanly when Perenual is unavailable.
 *
 * The pet-toxicity callout is intentional and prominent — it's the one
 * piece of data that's actively dangerous to miss, so we surface it as
 * a banner rather than burying it in a section.
 */
export function CareGuideCard({ perenualSpeciesId }: CareGuideCardProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['species', 'guide', perenualSpeciesId],
    queryFn: () => speciesService.careGuide(perenualSpeciesId),
    staleTime: 60 * 60 * 1000,
  });

  if (isLoading || !data) return null;

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

      {data.poisonousToPets === true && (
        <div
          role="note"
          className="mb-4 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 flex-none" aria-hidden="true" />
          <span>
            <strong>Toxic to pets.</strong> Keep out of reach of cats and dogs.
          </span>
        </div>
      )}

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
