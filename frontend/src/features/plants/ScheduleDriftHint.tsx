import { useTranslation } from 'react-i18next';
import { ArrowsRightLeftIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/Button';
import type { ScheduleDrift } from '@/services/taskService';

interface ScheduleDriftHintProps {
  drift: ScheduleDrift | undefined;
  onMatch: () => void;
  isMatching: boolean;
}

/**
 * "You do this about every N days but it's scheduled every M — match the
 * schedule to reality?" Renders ONLY for a reading the server flagged as
 * over the threshold. `drift: null` (too little history, or the history read
 * failed) renders nothing — the server's reason is in the payload, and an
 * absent suggestion is not a claim that the schedule is right.
 */
export function ScheduleDriftHint({ drift, onMatch, isMatching }: ScheduleDriftHintProps) {
  const { t } = useTranslation();
  if (!drift?.drift?.exceedsThreshold) return null;

  const actual = t('scheduleDrift.everyDays', { count: drift.drift.suggestedFrequency });
  const scheduled = t('scheduleDrift.everyDays', { count: drift.scheduledIntervalDays });

  return (
    <div
      className="mt-2 flex flex-col gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 sm:flex-row sm:items-center sm:justify-between"
      role="status"
    >
      <p>{t('scheduleDrift.hint', { actual, scheduled })}</p>
      <Button
        size="sm"
        variant="secondary"
        onClick={onMatch}
        isLoading={isMatching}
        leftIcon={<ArrowsRightLeftIcon className="h-4 w-4" aria-hidden="true" />}
        className="shrink-0"
      >
        {t('scheduleDrift.match')}
      </Button>
    </div>
  );
}
