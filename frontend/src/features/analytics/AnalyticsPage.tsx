import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { householdService } from '@/services/householdService';
import { taskService } from '@/services/taskService';
import { plantService } from '@/services/plantService';
import { Card, CardHeader } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import clsx from 'clsx';

/**
 * Care analytics — KPI tiles + four views over the same data feed:
 *   - 30-day completion trend (bars + 7-day moving average)
 *   - By task type (water vs fertilize vs prune vs …)
 *   - Plants at risk (overdue tasks, ranked)
 *   - Per-member contribution this year
 *
 * No new endpoints beyond /analytics/daily, /year-in-review, /tasks, and
 * /plants — everything is computed client-side from data the dashboard
 * already needs anyway.
 */

const TASK_TYPE_LABELS: Record<string, string> = {
  water: 'Water',
  fertilize: 'Fertilize',
  prune: 'Prune',
  repot: 'Repot',
  custom: 'Custom',
};

const TASK_TYPE_COLORS: Record<string, string> = {
  water: 'bg-blue-500',
  fertilize: 'bg-green-500',
  prune: 'bg-orange-500',
  repot: 'bg-purple-500',
  custom: 'bg-gray-500',
};

function isOverdue(nextDue: string, now = new Date()): boolean {
  const due = new Date(nextDue);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  return due.getTime() < today.getTime();
}

function daysOverdue(nextDue: string, now = new Date()): number {
  const due = new Date(nextDue);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  return Math.floor((today.getTime() - due.getTime()) / (24 * 60 * 60 * 1000));
}
export function AnalyticsPage() {
  useDocumentTitle('Analytics');
  const householdId = useActiveHouseholdId();

  const { data: daily, isLoading: dailyLoading } = useQuery({
    queryKey: ['household', householdId, 'analytics', 'daily', 30],
    queryFn: () => householdService.getDailyAnalytics(householdId!, 30),
    enabled: !!householdId,
  });

  const yearNow = new Date().getFullYear();
  const { data: review } = useQuery({
    queryKey: ['household', householdId, 'year-in-review', yearNow],
    queryFn: () => householdService.getYearInReview(householdId!, yearNow),
    enabled: !!householdId,
  });

  const { data: plants } = useQuery({
    queryKey: ['plants', householdId],
    queryFn: () => plantService.getPlants(),
    enabled: !!householdId,
  });

  const { data: tasks } = useQuery({
    queryKey: ['tasks', householdId, 'all'],
    queryFn: () => taskService.getTasks(),
    enabled: !!householdId,
  });

  if (!householdId) return null;

  // KPI tiles use already-fetched data — no extra round-trip.
  const overdueTasks = (tasks ?? []).filter((t) => isOverdue(t.nextDue));
  const last7DaysCount = (daily?.series ?? []).slice(-7).reduce((sum, d) => sum + d.count, 0);

  // At-risk = plants whose tasks are overdue. Rank by max-days-overdue across
  // their tasks so the most-neglected plant surfaces first.
  const atRisk = (plants ?? [])
    .map((plant) => {
      const plantTasks = (tasks ?? []).filter((t) => t.plantId === plant.id);
      const overdue = plantTasks.filter((t) => isOverdue(t.nextDue));
      const worst = overdue.reduce((m, t) => Math.max(m, daysOverdue(t.nextDue)), 0);
      return { plant, overdueCount: overdue.length, worst };
    })
    .filter((row) => row.overdueCount > 0)
    .sort((a, b) => b.worst - a.worst)
    .slice(0, 5);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Care rhythm"
        title="Analytics"
        description="How your household is doing on plant care."
      />

      {/* KPI tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KpiTile label="Plants" value={(plants ?? []).length} />
        <KpiTile label="Active tasks" value={(tasks ?? []).length} />
        <KpiTile label="Done last 7 days" value={last7DaysCount} />
        <KpiTile
          label="Overdue now"
          value={overdueTasks.length}
          tone={overdueTasks.length > 0 ? 'warning' : undefined}
        />
      </div>

      {/* 30-day trend */}
      <Card padding="none">
        <div className="px-6 py-4 border-b border-gray-200">
          <CardHeader title="Last 30 days" description="Completed tasks per day." />
        </div>
        <div className="p-6">
          {dailyLoading ? (
            <div className="flex justify-center py-6">
              <LoadingSpinner />
            </div>
          ) : (
            <DailyTrend series={daily?.series ?? []} />
          )}
        </div>
      </Card>

      {/* By task type */}
      {review && review.byTaskType.length > 0 && (
        <Card padding="none">
          <div className="px-6 py-4 border-b border-gray-200">
            <CardHeader
              title={`By task type in ${yearNow}`}
              description="What kind of care your household has put in this year."
            />
          </div>
          <ul className="divide-y divide-gray-200">
            {(() => {
              const total = review.byTaskType.reduce((s, b) => s + b.count, 0) || 1;
              return [...review.byTaskType]
                .sort((a, b) => b.count - a.count)
                .map((b) => {
                  const pct = (b.count / total) * 100;
                  return (
                    <li key={b.type} className="flex items-center gap-3 px-6 py-3 text-sm">
                      <span className="w-32 capitalize text-gray-900">
                        {TASK_TYPE_LABELS[b.type] ?? b.type}
                      </span>
                      <span
                        className={clsx(
                          'h-3 rounded-full',
                          TASK_TYPE_COLORS[b.type] ?? 'bg-gray-400'
                        )}
                        style={{ width: `${pct}%`, minWidth: '4px' }}
                        aria-hidden="true"
                      />
                      <span className="ml-auto text-gray-600 tabular-nums">
                        {b.count} ({Math.round(pct)}%)
                      </span>
                    </li>
                  );
                });
            })()}
          </ul>
        </Card>
      )}

      {/* Plants at risk */}
      {atRisk.length > 0 && (
        <Card padding="none">
          <div className="px-6 py-4 border-b border-gray-200">
            <CardHeader
              title="Plants at risk"
              description="Tasks overdue — the most-overdue plant first."
            />
          </div>
          <ul className="divide-y divide-gray-200">
            {atRisk.map(({ plant, overdueCount, worst }) => (
              <li key={plant.id} className="px-6 py-3 text-sm">
                <Link
                  to={`/plants/${plant.id}`}
                  className="flex items-center gap-3 hover:bg-gray-50 -mx-6 px-6 py-1 -my-1"
                >
                  <span className="flex-1 truncate font-medium text-gray-900">{plant.name}</span>
                  <span className="text-amber-700 tabular-nums">{overdueCount} overdue</span>
                  <span className="text-gray-500 tabular-nums">worst {worst}d</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Per-member */}
      {review && review.byMember.length > 0 && (
        <Card padding="none">
          <div className="px-6 py-4 border-b border-gray-200">
            <CardHeader
              title={`Top contributors in ${yearNow}`}
              description="Tasks each member has completed this year."
            />
          </div>
          <ul className="divide-y divide-gray-200">
            {review.byMember.map((m) => {
              const max = review.byMember[0].count || 1;
              const pct = (m.count / max) * 100;
              return (
                <li key={m.userId} className="flex items-center gap-3 px-6 py-3 text-sm">
                  <span className="w-32 truncate text-gray-900">{m.name}</span>
                  <span
                    className="h-3 rounded-full bg-primary-600"
                    style={{ width: `${pct}%`, minWidth: '4px' }}
                    aria-hidden="true"
                  />
                  <span className="ml-auto text-gray-600 tabular-nums">{m.count}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* Per-plant */}
      {plants && tasks && (
        <Card padding="none">
          <div className="px-6 py-4 border-b border-gray-200">
            <CardHeader title="Per plant" description="Recent task activity by plant." />
          </div>
          <ul className="divide-y divide-gray-200">
            {plants
              .map((plant) => ({
                plant,
                count: review?.topPlants.find((p) => p.plantId === plant.id)?.count ?? 0,
                taskCount: tasks.filter((t) => t.plantId === plant.id).length,
              }))
              .sort((a, b) => b.count - a.count)
              .slice(0, 10)
              .map(({ plant, count, taskCount }) => (
                <li key={plant.id} className="flex items-center gap-3 px-6 py-3 text-sm">
                  <span className="w-40 truncate text-gray-900">{plant.name}</span>
                  <span className="text-gray-600">
                    {taskCount} task{taskCount === 1 ? '' : 's'}
                  </span>
                  <span className="ml-auto text-gray-600 tabular-nums">{count} completed</span>
                </li>
              ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

interface DailyTrendProps {
  series: Array<{ date: string; count: number }>;
}

/**
 * Compute a centered-window moving average so the line tracks under each
 * bar without lagging at the edges. We expand the window asymmetrically
 * near boundaries — a hard 7-day backward window would leave the first
 * 6 days flat at zero, which misrepresents a freshly-onboarded household.
 */
function movingAverage(values: number[], window = 7): number[] {
  const half = Math.floor(window / 2);
  return values.map((_, i) => {
    const start = Math.max(0, i - half);
    const end = Math.min(values.length, i + half + 1);
    const slice = values.slice(start, end);
    const sum = slice.reduce((s, v) => s + v, 0);
    return slice.length ? sum / slice.length : 0;
  });
}

function DailyTrend({ series }: DailyTrendProps) {
  const max = Math.max(1, ...series.map((d) => d.count));
  const counts = series.map((d) => d.count);
  const avg = movingAverage(counts);
  const total = counts.reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-2">
      <div
        className="relative flex items-end gap-1 h-24"
        role="img"
        aria-label={`30-day completion trend, total ${total} tasks. 7-day moving average overlaid.`}
      >
        {series.map((d) => {
          const heightPct = (d.count / max) * 100;
          return (
            <div
              key={d.date}
              className="flex-1 group relative"
              title={`${d.date}: ${d.count} task${d.count === 1 ? '' : 's'}`}
            >
              <div
                className={clsx(
                  'rounded-t transition-colors',
                  d.count > 0 ? 'bg-primary-600' : 'bg-gray-200'
                )}
                style={{ height: `${heightPct}%`, minHeight: '4px' }}
              />
            </div>
          );
        })}
        {/* SVG overlay for the moving-average polyline. Pointer-events-none
            so tooltips on the bars still work. */}
        <svg
          aria-hidden="true"
          className="absolute inset-0 pointer-events-none"
          viewBox={`0 0 ${series.length || 1} 100`}
          preserveAspectRatio="none"
        >
          <polyline
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            className="text-primary-900/60"
            points={avg.map((v, i) => `${i + 0.5},${100 - (v / max) * 100}`).join(' ')}
          />
        </svg>
      </div>
      <p className="text-xs text-gray-500">
        Bars: tasks completed per day. Line: 7-day moving average.
      </p>
    </div>
  );
}

function KpiTile({ label, value, tone }: { label: string; value: number; tone?: 'warning' }) {
  return (
    <div
      className={clsx(
        'rounded-lg border p-4',
        tone === 'warning' ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-white'
      )}
    >
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p
        className={clsx(
          'mt-1 text-2xl font-semibold tabular-nums',
          tone === 'warning' ? 'text-amber-900' : 'text-gray-900'
        )}
      >
        {value}
      </p>
    </div>
  );
}
