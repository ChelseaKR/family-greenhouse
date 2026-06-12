import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader } from '@/components/Card';
import { householdService } from '@/services/householdService';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';

const TYPE_LABELS: Record<string, string> = {
  water: 'Watering',
  fertilize: 'Fertilizing',
  prune: 'Pruning',
  repot: 'Repotting',
  custom: 'Other',
};

/**
 * Year-in-review summary as a dashboard card. Always visible — even outside
 * December — because seeing your own data is satisfying year-round. The
 * data feed is the same `getYearInReview` endpoint we'll later use for an
 * end-of-year recap email.
 *
 * If there are no completions this year, we hide the card entirely rather
 * than show empty bars.
 */
export function YearInReviewCard() {
  const householdId = useActiveHouseholdId();
  const year = new Date().getFullYear();

  const { data: review } = useQuery({
    queryKey: ['household', householdId, 'year-in-review', year],
    queryFn: () => householdService.getYearInReview(householdId!, year),
    enabled: !!householdId,
  });

  if (!review || review.totalCompletions === 0) return null;

  const max = Math.max(...review.byTaskType.map((t) => t.count));
  const topMember = review.byMember[0];

  return (
    <Card padding="none">
      <div className="px-6 py-4 border-b border-gray-200">
        <CardHeader
          title={`Your ${year}`}
          description="Care work this household has done so far this year."
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 p-6">
        <Stat label="Total tasks completed" value={review.totalCompletions.toLocaleString()} />
        <Stat
          label="Top contributor"
          value={topMember ? topMember.name : '—'}
          sub={topMember ? `${topMember.count} tasks` : undefined}
        />
        <Stat
          label="Tasks per week"
          value={(review.totalCompletions / weeksElapsed(year)).toFixed(1)}
        />
      </div>

      {/* Bar chart by task type */}
      <div className="px-6 pb-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Where the work went</h3>
        <ul className="space-y-2">
          {review.byTaskType.map((row) => {
            const pct = max ? (row.count / max) * 100 : 0;
            return (
              <li key={row.type} className="flex items-center gap-3">
                <span className="w-24 text-sm text-gray-700">
                  {TYPE_LABELS[row.type] ?? row.type}
                </span>
                <span
                  className="h-3 rounded-full bg-primary-600"
                  style={{ width: `${pct}%`, minWidth: pct > 0 ? '4px' : 0 }}
                  aria-hidden="true"
                />
                <span className="text-sm text-gray-600 tabular-nums">{row.count}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}

interface StatProps {
  label: string;
  value: string;
  sub?: string;
}

function Stat({ label, value, sub }: StatProps) {
  return (
    <div>
      <p className="text-sm text-gray-600">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
      {sub && <p className="text-xs text-gray-600">{sub}</p>}
    </div>
  );
}

/** Pure-function week count from year start to today (≥1). */
function weeksElapsed(year: number): number {
  const start = new Date(year, 0, 1).getTime();
  const now = Date.now();
  return Math.max(1, Math.round((now - start) / (7 * 24 * 60 * 60 * 1000)));
}
