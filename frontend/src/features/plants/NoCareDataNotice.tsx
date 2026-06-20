import { InformationCircleIcon } from '@heroicons/react/24/outline';
import { Card } from '@/components/Card';

/**
 * Honest placeholder shown when we have no care data for a plant's species —
 * neither a curated guide nor a Perenual match. Without it, the care guide and
 * suggested schedule simply vanish with no explanation (a leaky abstraction).
 * We'd rather tell the user why the cards are missing than leave a blank gap.
 */
export function NoCareDataNotice() {
  return (
    <Card padding="none">
      <div className="flex gap-3 p-6">
        <InformationCircleIcon
          className="h-5 w-5 flex-shrink-0 text-primary-500"
          aria-hidden="true"
        />
        <div className="text-sm text-gray-700">
          <h2 className="font-semibold text-gray-900">No care guide for this species yet</h2>
          <p className="mt-1">
            We don&apos;t recognise this species, so the care guide and suggested schedule are
            hidden — we&apos;d rather show nothing than guess. You can still add your own care tasks
            below, or pick a recognised species when editing this plant.
          </p>
        </div>
      </div>
    </Card>
  );
}
