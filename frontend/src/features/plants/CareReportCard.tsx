import { Card, CardHeader } from '@/components/Card';
import type { PlantWithTasks, Task } from '@/services/plantService';
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
 */
export function CareReportCard({ plant }: CareReportCardProps) {
  const completions = plant.recentCompletions;
  const totalTasks = plant.upcomingTasks.length;
  const totalCompletions = completions.length;

  const lastCompletion = completions
    .map((c) => c.completedAt)
    .sort()
    .at(-1);

  const overallBestStreak = plant.upcomingTasks.reduce(
    (max, t) => Math.max(max, longestStreak(t, completions)),
    0
  );

  return (
    <Card>
      <CardHeader
        title="Care report"
        description="Snapshot of how this plant has been cared for."
      />

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6 text-sm">
        <Stat label="Active tasks" value={totalTasks.toString()} />
        <Stat label="Total completions" value={totalCompletions.toString()} />
        <Stat
          label="Longest streak"
          value={overallBestStreak >= 2 ? `${overallBestStreak} cycles` : '—'}
        />
        <Stat label="Last care" value={lastCompletion ? formatRelative(lastCompletion) : 'Never'} />
      </dl>

      {plant.upcomingTasks.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
            By task
          </h4>
          <ul className="divide-y divide-gray-200 text-sm">
            {plant.upcomingTasks.map((t) => (
              <TaskRow key={t.id} task={t} completions={completions} />
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
      <dt className="text-xs font-medium text-gray-500">{label}</dt>
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
  const own = completions.filter((c) => c.taskId === task.id);
  const best = longestStreak(task, completions);
  const last = own
    .map((c) => c.completedAt)
    .sort()
    .at(-1);
  const label = task.customType ?? task.type;

  return (
    <li className="flex items-center justify-between py-2">
      <span className="font-medium capitalize text-gray-900">{label}</span>
      <div className="flex gap-4 text-gray-600">
        <span>{own.length} done</span>
        <span>best {best >= 2 ? `${best}×` : '—'}</span>
        <span className="hidden sm:inline">last {last ? formatRelative(last) : 'never'}</span>
      </div>
    </li>
  );
}

function formatRelative(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
