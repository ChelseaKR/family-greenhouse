/**
 * Shared task-row affordances used by both TasksPage and the dashboard's
 * upcoming-tasks card:
 *
 *   - "Up for grabs" badge + Claim / Unclaim buttons (task claiming)
 *   - "X asked for help" badge + their note (ADR 0024)
 *   - "Ask family to do it" button
 *   - "Covering for X" badge (vacation-mode read-time annotation)
 *   - climate skip chip ("Rain expected — skip this cycle?")
 *
 * Components only — the matching mutation hooks live in taskMutations.ts.
 */
import { useTranslation } from 'react-i18next';
import { HandRaisedIcon, CloudIcon, MegaphoneIcon } from '@heroicons/react/24/outline';
import { SnoozeReason, TaskWithCoverage } from '@/services/taskService';
import type { Task } from '@/services/plantService';
import { hemisphereForLatitude, nextCadenceChange, resolveCadence } from './seasonalCadence';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/Button';
import { isHelpRequestOpen } from './helpRequest';

/**
 * `escalated` marks an occurrence that auto-handoff put up for grabs (ADR
 * 0018) — same badge, one extra word, so the reader knows the app asked and
 * no housemate did.
 */
export function UpForGrabsBadge({ escalated = false }: { escalated?: boolean }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-300/70">
      {escalated ? t('tasks.upForGrabsEscalated') : t('tasks.upForGrabs')}
    </span>
  );
}

/**
 * "Sam asked for help" — and, on its own line, why. The note is the whole
 * reason the ask beats a silent `unclaim`, so it is rendered rather than
 * hidden behind a tooltip; the badge row is `flex-wrap`, so `basis-full`
 * puts the quote underneath the chips.
 */
export function AskedForHelpBadge({ name, note }: { name: string | null; note?: string | null }) {
  const { t } = useTranslation();
  return (
    <>
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 ring-1 ring-amber-300/70">
        <MegaphoneIcon className="h-3.5 w-3.5" aria-hidden="true" />
        {name ? t('tasks.askedByBadge', { name }) : t('tasks.askedBadge')}
      </span>
      {note && (
        <span className="basis-full text-xs italic text-primary-800">
          {t('tasks.askedNote', { note })}
        </span>
      )}
    </>
  );
}

interface AskFamilyButtonProps {
  task: TaskWithCoverage;
  onAsk: (task: TaskWithCoverage) => void;
  isPending: boolean;
}

/**
 * The other way out of "I can't do this one". `unclaim` releases the task and
 * tells nobody; this asks. Hidden once an ask is already open on the
 * occurrence (asking twice would just be noise) and when somebody else
 * explicitly holds the task — releasing their work is their call, and the
 * server refuses it with a 403 anyway.
 */
export function AskFamilyButton({ task, onAsk, isPending }: AskFamilyButtonProps) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  if (isHelpRequestOpen(task)) return null;
  const heldByAnother =
    !!task.assignedTo && task.assignmentSource === null && task.assignedTo !== user?.id;
  if (heldByAnother) return null;
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => onAsk(task)}
      disabled={isPending}
      leftIcon={<MegaphoneIcon className="h-4 w-4" aria-hidden="true" />}
      aria-label={t('tasks.askFamilyAria', { plant: task.plantName })}
    >
      {t('tasks.askFamily.button')}
    </Button>
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

/** Claim unassigned work, take over a space default, or unclaim your task. */
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
  // Inherited every way — a space default, a Move Day split, or this cycle's
  // rotation turn.
  if (
    task.assignmentSource === 'space_default' ||
    task.assignmentSource === 'move_day' ||
    task.assignmentSource === 'rotation'
  ) {
    return (
      <Button
        variant="secondary"
        size="sm"
        onClick={() => onClaim(task.id)}
        disabled={isPending}
        leftIcon={<HandRaisedIcon className="h-4 w-4" aria-hidden="true" />}
        aria-label={t('tasks.takeOverAria', { plant: task.plantName })}
      >
        {t('tasks.takeOver')}
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
      className="inline-flex min-h-touch items-center gap-1 rounded-full border border-sky-300/80 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-800 transition-colors hover:bg-sky-100 disabled:opacity-50"
    >
      <CloudIcon className="h-3.5 w-3.5" aria-hidden="true" />
      {reason === 'rain' ? t('tasks.skipRain') : t('tasks.skipFrost')}
    </button>
  );
}

/**
 * "every 14 days · autumn cadence until 1 Mar" — what a seasonally-scheduled
 * task is ACTUALLY on right now (`features/tasks/seasonalCadence.ts`).
 *
 * The badge exists because the task row's headline interval is the task's base
 * `frequency`, and on a task with a seasonal profile that is not the number
 * the schedule uses. A row that says "every 7 days" while the server advances
 * by 14 is this repo's named defect class wearing a different hat: a value
 * rendered where the real answer is somewhere else.
 *
 * Renders nothing for a task with no profile (every task today). A household
 * with no location gets the "seasons unavailable" line rather than a silently
 * assumed hemisphere — the profile is set, so the household HAS asked for
 * seasonal scheduling and is entitled to know why it is not happening.
 */
export function SeasonalCadenceBadge({
  task,
  latitude,
  now,
}: {
  task: Pick<Task, 'frequency' | 'seasonalCadences'>;
  latitude: number | null | undefined;
  now?: Date;
}) {
  const { t, i18n } = useTranslation();
  if (!task.seasonalCadences || task.seasonalCadences.length === 0) return null;

  const at = now ?? new Date();
  const hemisphere = hemisphereForLatitude(latitude);
  const resolved = resolveCadence(task.frequency, task.seasonalCadences, hemisphere, at);

  if (resolved.season === null) {
    return (
      <span className="inline-flex items-center rounded-full bg-primary-50 px-2 py-0.5 text-xs font-medium text-primary-900 ring-1 ring-primary-200">
        {t('tasks.seasonal.noLocation')}
      </span>
    );
  }

  const interval = t('tasks.seasonal.interval', { count: resolved.frequency });
  const season = t(`tasks.seasonal.season.${resolved.season}`);
  const changesOn = nextCadenceChange(task.frequency, task.seasonalCadences, hemisphere, at);
  const label = changesOn
    ? t('tasks.seasonal.chipUntil', {
        interval,
        season,
        date: changesOn.toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' }),
      })
    : t('tasks.seasonal.chip', { interval, season });

  return (
    <span className="inline-flex items-center rounded-full bg-primary-50 px-2 py-0.5 text-xs font-medium text-primary-900 ring-1 ring-primary-200">
      {label}
    </span>
  );
}
