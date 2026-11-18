import { InformationCircleIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/Card';

/**
 * Honest placeholder shown when we have no care data for a plant's species —
 * neither a curated guide nor a Perenual match. Without it, the care guide and
 * suggested schedule simply vanish with no explanation (a leaky abstraction).
 * We'd rather tell the user why the cards are missing than leave a blank gap.
 */
export function NoCareDataNotice() {
  const { t } = useTranslation();
  return (
    <Card padding="none">
      <div className="flex gap-3 p-6">
        <InformationCircleIcon className="h-5 w-5 shrink-0 text-primary-500" aria-hidden="true" />
        <div className="text-sm text-gray-700">
          <h2 className="font-semibold text-gray-900">{t('plants.noCareData.title')}</h2>
          <p className="mt-1">{t('plants.noCareData.body')}</p>
        </div>
      </div>
    </Card>
  );
}
