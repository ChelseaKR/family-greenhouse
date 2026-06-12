/**
 * Shared task-row affordances used by both TasksPage and the dashboard's
 * upcoming-tasks card:
 *
 *   - "Up for grabs" badge + Claim / Unclaim buttons (task claiming)
 *   - "Covering for X" badge (vacation-mode read-time annotation)
 *   - climate skip chip ("Rain expected — skip this cycle?")
 *
 * Components only — the matching mutation hooks live in taskMutations.ts.
 */
import { useTranslation } from 'react-i18next';
import { HandRaisedIcon, CloudIcon } from '@heroicons/react/24/outline';
import { SnoozeReason, TaskWithCoverage } from '@/services/taskService';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/Button';

export function UpForGrabsBadge() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-300/70">
      {t('tasks.upForGrabs')}
    </span>
  );
}

export function CoveringBadge({ name }: { name: string }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center rounded-full bg-primary-50 px-2 py-0.5 text-xs font-medium text-primary-800 ring-1 ring-primary-300/70">
      {t('tasks.coveringFor', { name })}
    </span>
  );
}

interface ClaimControlsProps {
  task: TaskWithCoverage;
  onClaim: (taskId: string) => void;
  onUnclaim: (taskId: string) => void;
  isPending: boolean;
}

/** Claim (unassigned) / Unclaim (assigned to me) button for a task row. */
export function ClaimControls({ task, onClaim, onUnclaim, isPending }: ClaimControlsProps) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  if (!task.assignedTo) {
    return (
      <Button
        variant="secondary"
        size="sm"
        onClick={() => onClaim(task.id)}
        disabled={isPending}
        leftIcon={<HandRaisedIcon className="h-4 w-4" aria-hidden="true" />}
        aria-label={t('tasks.claimAria', { plant: task.plantName })}
      >
        {t('tasks.claim')}
      </Button>
    );
  }
  if (task.assignedTo === user?.id) {
    return (
      <Button
        variant="secondary"
        size="sm"
        onClick={() => onUnclaim(task.id)}
        disabled={isPending}
        aria-label={t('tasks.unclaimAria', { plant: task.plantName })}
      >
        {t('tasks.unclaim')}
      </Button>
    );
  }
  return null;
}

interface ClimateSkipChipProps {
  reason: Extract<SnoozeReason, 'rain' | 'frost'>;
  onSkip: () => void;
  isPending: boolean;
}

/** "Rain expected — skip this cycle?" suggestion chip. */
export function ClimateSkipChip({ reason, onSkip, isPending }: ClimateSkipChipProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onSkip}
      disabled={isPending}
      className="inline-flex items-center gap-1 rounded-full border border-sky-300/80 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-800 transition-colors hover:bg-sky-100 disabled:opacity-50"
    >
      <CloudIcon className="h-3.5 w-3.5" aria-hidden="true" />
      {reason === 'rain' ? t('tasks.skipRain') : t('tasks.skipFrost')}
    </button>
  );
}
