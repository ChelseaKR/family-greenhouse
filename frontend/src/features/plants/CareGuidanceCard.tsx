import { Card, CardHeader } from '@/components/Card';
import { findCareGuide } from '@/utils/careGuidance';

interface CareGuidanceCardProps {
  species: string | null | undefined;
}

/**
 * If the plant's species matches a curated entry, render a four-section
 * care card (light, water, humidity, notes). Renders nothing when there's
 * no match — we never fabricate guidance.
 */
export function CareGuidanceCard({ species }: CareGuidanceCardProps) {
  const guide = findCareGuide(species);
  if (!guide) return null;
  return (
    <Card padding="none">
      <div className="px-6 py-4 border-b border-gray-200">
        <CardHeader
          title={`Caring for ${guide.common}`}
          description={`Curated tips for ${guide.scientific}.`}
        />
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 p-6 text-sm">
        <div>
          <dt className="font-semibold text-gray-900">Light</dt>
          <dd className="mt-1 text-gray-700">{guide.light}</dd>
        </div>
        <div>
          <dt className="font-semibold text-gray-900">Water</dt>
          <dd className="mt-1 text-gray-700">{guide.water}</dd>
        </div>
        <div>
          <dt className="font-semibold text-gray-900">Humidity</dt>
          <dd className="mt-1 text-gray-700">{guide.humidity}</dd>
        </div>
        <div>
          <dt className="font-semibold text-gray-900">Notes</dt>
          <dd className="mt-1 text-gray-700">{guide.notes}</dd>
        </div>
      </dl>
    </Card>
  );
}
