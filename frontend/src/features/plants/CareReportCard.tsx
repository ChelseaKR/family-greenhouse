import { useTranslation } from 'react-i18next';
import { Card, CardHeader } from '@/components/Card';
import { RECENT_COMPLETIONS_LIMIT } from '@/services/plantService';
import type { PlantWithTasks, Task } from '@/services/plantService';
import { taskTypeName } from '@/utils/taskTypeConfig';
import { longestStreak } from '@/utils/streaks';

interface CareReportCardProps {
  plant: PlantWithTasks;
}

/**
 * Aggregate care stats for a single plant. Drives off whatever the plant
 * detail endpoint returns: upcomingTasks gives us the live tasks, and
 * recentCompletions gives us the per-task history we need for streaks
 * and counts. We don't fetch additional data here — keeping it cheap so
 * the card stays in step with the rest of the page's loading state.
 *
 * Every count and streak on this card is computed from
 * `plant.recentCompletions`, which `GET /plants/{id}` caps at
 * RECENT_COMPLETIONS_LIMIT rows across ALL of the plant's tasks. So the
 * numbers are bounded by that window and cannot exceed it — a plant watered
 * fifty times still has at most RECENT_COMPLETIONS_LIMIT rows to count. This
 * card used to label that capped count "Total completions" and the capped
 * run "Longest streak", which made a ceiling look like a measurement. Every
 * label here states the window; if you ever want true lifetime figures they
 * have to be aggregated server-side, not inferred from this list.
 */
export function CareReportCard({ plant }: CareReportCardProps) {
  const { t } = useTranslation();
  const completions = plant.recentCompletions;
  const totalTasks = plant.upcomingTasks.length;
  const totalCompletions = completions.length;

  // "Last care" is not bounded by the window: every task carries its own
  // `lastCompleted`, so a fertilize that fell out of the newest
  // RECENT_COMPLETIONS_LIMIT rows still counts here. "Never" only when no
  // task has ever been done.
  const lastCompletion = newest([
    ...completions.map((c) => c.completedAt),
    ...plant.upcomingTasks.map((task) => task.lastCompleted),
  ]);

  const overallBestStreak = plant.upcomingTasks.reduce(
    (max, task) => Math.max(max, longestStreak(task, completions)),
    0
  );

  return (
    <Card>
      <CardHeader
        title={t('plants.careReport.title')}
        description={t('plants.careReport.description', { limit: RECENT_COMPLETIONS_LIMIT })}
      />

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6 text-sm large-text:grid-cols-1">
        <Stat label={t('plants.careReport.activeTasks')} value={totalTasks.toString()} />
        <Stat
          label={t('plants.careReport.completions', { limit: RECENT_COMPLETIONS_LIMIT })}
          value={totalCompletions.toString()}
        />
        <Stat
          label={t('plants.careReport.bestStreak', { limit: RECENT_COMPLETIONS_LIMIT })}
          value={
            overallBestStreak >= 2
              ? t('plants.careReport.cycles', { count: overallBestStreak })
              : '—'
          }
        />
        <Stat
          label={t('plants.careReport.lastCare')}
          value={lastCompletion ? formatRelative(lastCompletion, t, 'stat') : t('common.never')}
        />
      </dl>

      {plant.upcomingTasks.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600 mb-2">
            {t('plants.careReport.byTask', { limit: RECENT_COMPLETIONS_LIMIT })}
          </h4>
          <ul className="divide-y divide-primary-100/60 text-sm">
            {plant.upcomingTasks.map((task) => (
              <TaskRow key={task.id} task={task} completions={completions} />
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-gray-600">{label}</dt>
      <dd className="mt-1 text-lg font-semibold text-gray-900">{value}</dd>
    </div>
  );
}

function TaskRow({
  task,
  completions,
}: {
  task: Task;
  completions: PlantWithTasks['recentCompletions'];
}) {
  const { t } = useTranslation();
  const own = completions.filter((c) => c.taskId === task.id);
  const best = longestStreak(task, completions);
  // The task's own `lastCompleted` is the true last date; the window only
  // holds the newest RECENT_COMPLETIONS_LIMIT rows across all tasks, so a
  // rare task next to a frequent one drops out of it within weeks.
  const last = newest([task.lastCompleted, ...own.map((c) => c.completedAt)]);
  const label = taskTypeName(t, task.customType ?? task.type);
  const doneLabel =
    own.length > 0 || !last
      ? t('plants.careReport.doneCount', { count: own.length })
      : t('plants.careReport.noneInLast', { limit: RECENT_COMPLETIONS_LIMIT });

  return (
    <li className="flex items-center justify-between py-2">
      <span className="font-medium capitalize text-gray-900">{label}</span>
      <div className="flex gap-4 text-gray-600">
        <span>{doneLabel}</span>
        <span>{t('plants.careReport.best', { value: best >= 2 ? `${best}×` : '—' })}</span>
        <span className="hidden sm:inline">
          {t('plants.careReport.last', {
            value: last ? formatRelative(last, t) : t('plants.careReport.never'),
          })}
        </span>
      </div>
    </li>
  );
}

/** The latest of the given ISO timestamps, ignoring missing or unreadable ones. */
function newest(isos: Array<string | null | undefined>): string | undefined {
  let best: string | undefined;
  let bestMs = -Infinity;
  for (const iso of isos) {
    if (!iso) continue;
    const ms = new Date(iso).getTime();
    if (Number.isFinite(ms) && ms > bestMs) {
      best = iso;
      bestMs = ms;
    }
  }
  return best;
}

/**
 * How long ago, in the reader's language. `stat` is the stand-alone value
 * under "Last care", which Spanish starts with a capital ("Hace 3 días");
 * without it the words go inside "last: …" ("último: hace 3 días").
 */
function formatRelative(
  iso: string,
  t: ReturnType<typeof useTranslation>['t'],
  context?: 'stat'
): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));
  const key = (name: string) => `plants.careReport.${name}`;
  if (days <= 0) return t(key('relToday'), { context });
  if (days === 1) return t(key('relYesterday'), { context });
  if (days < 7) return t(key('relDays'), { count: days, context });
  if (days < 30) return t(key('relWeeks'), { count: Math.floor(days / 7), context });
  return t(key('relMonths'), { count: Math.floor(days / 30), context });
}
