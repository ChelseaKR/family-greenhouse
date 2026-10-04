import type { TaskWithCoverage } from '@/services/taskService';
import { calendarDaysBetween } from '@/utils/date';

/**
 * The phone Tasks list ("Checklist"): the website under 640px and the iOS
 * app. Two segments, Today (overdue first, then due today) and Upcoming
 * (tomorrow on, one section per day). Pure functions, so the order a person
 * sees is pinned by unit tests rather than by whatever order the API sent.
 */

export type Segment = 'today' | 'upcoming';

export interface ChecklistItem {
  task: TaskWithCoverage;
  /** Calendar days until the task is due: negative is overdue, 0 is today. */
  days: number;
  plantName: string;
}

export interface ChecklistSection {
  /** `overdue` | `today` | `day:<n>` (Upcoming) | a room id (grouped by room). */
  id: string;
  kind: 'overdue' | 'today' | 'day' | 'room';
  /** For `day` sections: how many days from today. */
  days?: number;
  items: ChecklistItem[];
}

export function checklistItems(
  tasks: readonly TaskWithCoverage[],
  plantNameOf: (task: TaskWithCoverage) => string,
  now: Date = new Date()
): ChecklistItem[] {
  return tasks.map((task) => ({
    task,
    days: calendarDaysBetween(now, new Date(task.nextDue)),
    plantName: plantNameOf(task),
  }));
}

/**
 * Most urgent first. Tasks due the same day sort by plant name, then by task
 * kind, then by id, so the order never depends on the time of day a task
 * happens to be stored with (the API's `nextDue` carries one), and it never
 * reshuffles between two reads of the same list.
 */
export function byDueThenName(a: ChecklistItem, b: ChecklistItem): number {
  return (
    a.days - b.days ||
    a.plantName.localeCompare(b.plantName) ||
    (a.task.customType || a.task.type).localeCompare(b.task.customType || b.task.type) ||
    a.task.id.localeCompare(b.task.id)
  );
}

export function inSegment(item: ChecklistItem, segment: Segment): boolean {
  return segment === 'today' ? item.days <= 0 : item.days > 0;
}

/** Today: Overdue, then Today. Upcoming: one section per day. Empty
 *  sections are dropped. */
export function dateSections(
  items: readonly ChecklistItem[],
  segment: Segment
): ChecklistSection[] {
  const sorted = items.filter((item) => inSegment(item, segment)).sort(byDueThenName);
  if (segment === 'today') {
    return [
      { id: 'overdue', kind: 'overdue' as const, items: sorted.filter((i) => i.days < 0) },
      { id: 'today', kind: 'today' as const, items: sorted.filter((i) => i.days === 0) },
    ].filter((section) => section.items.length > 0);
  }
  const byDay = new Map<number, ChecklistItem[]>();
  for (const item of sorted) byDay.set(item.days, [...(byDay.get(item.days) ?? []), item]);
  return [...byDay.entries()].map(([days, dayItems]) => ({
    id: `day:${days}`,
    kind: 'day' as const,
    days,
    items: dayItems,
  }));
}

/** How many tasks each segment holds, for the segment labels. */
export function segmentCounts(items: readonly ChecklistItem[]): Record<Segment, number> {
  let today = 0;
  for (const item of items) if (item.days <= 0) today += 1;
  return { today, upcoming: items.length - today };
}
