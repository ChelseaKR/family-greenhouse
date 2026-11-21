import { useTranslation } from 'react-i18next';
import { Card, CardHeader } from '@/components/Card';
import { findCareGuide } from '@/utils/careGuidance';

interface CareGuidanceCardProps {
  species: string | null | undefined;
  /** The plant's own name, as the household wrote it: the heading says
   *  "Caring for Peace Lily", not the catalog's "Peace lily". */
  plantName?: string;
}

/**
 * If the plant's species matches a curated entry, render a four-section
 * care card (light, water, humidity, notes). Renders nothing when there's
 * no match — we never fabricate guidance.
 */
export function CareGuidanceCard({ species, plantName }: CareGuidanceCardProps) {
  const { t } = useTranslation();
  const guide = findCareGuide(species);
  if (!guide) return null;
  return (
    <Card padding="none">
      <div className="px-6 py-4 border-b border-primary-100/70">
        <CardHeader
          title={t('plants.careGuidance.title', { name: plantName?.trim() || guide.common })}
          description={t('plants.careGuidance.description', { scientific: guide.scientific })}
        />
      </div>
      {/* The tips themselves are curated English (utils/careGuidance.ts) and
          stay English in every language for now; each one is marked lang="en"
          so a screen reader voices it with English rules. The headings around
          them come from the catalog and follow the page language. */}
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 p-6 text-sm">
        <div>
          <dt className="font-semibold text-gray-900">{t('plants.careGuidance.light')}</dt>
          <dd lang="en" className="mt-1 text-gray-700">
            {guide.light}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-gray-900">{t('plants.careGuidance.water')}</dt>
          <dd lang="en" className="mt-1 text-gray-700">
            {guide.water}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-gray-900">{t('plants.careGuidance.humidity')}</dt>
          <dd lang="en" className="mt-1 text-gray-700">
            {guide.humidity}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-gray-900">{t('plants.notesLabel')}</dt>
          <dd lang="en" className="mt-1 text-gray-700">
            {guide.notes}
          </dd>
        </div>
      </dl>
    </Card>
  );
}
