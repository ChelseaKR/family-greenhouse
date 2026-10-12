import type { Plant } from '@/services/plantService';
import type { TaskWithCoverage } from '@/services/taskService';
import { calendarDaysBetween } from '@/utils/date';

/**
 * Where a plant sits on the phone Plants list ("Today first").
 *
 * - `needs`: its most urgent task is due today or overdue.
 * - `soon`: due within the next 7 days.
 * - `later`: everything else that has a schedule.
 * - `none`: the plant has no care task at all. That is NOT "all good": a
 *   plant nobody scheduled is a fact of its own, so it gets its own group
 *   and never borrows the healthy one.
 *
 * There is deliberately no bucket for "the tasks read failed": that case
 * never reaches this function (see `groupPlantCare`), because a plant whose
 * tasks we could not read has no status at all rather than a healthy one.
 */
export type CareBucket = 'needs' | 'soon' | 'later' | 'none';

export interface PlantCare {
  plant: Plant;
  /** The plant's most urgent task (earliest `nextDue`); absent for `none`. */
  task?: TaskWithCoverage;
  /** Calendar days until `task` is due: negative is overdue, 0 is today. */
  days?: number;
  bucket: CareBucket;
}

export const SOON_DAYS = 7;

/** Earliest-due task per plant id. Ties keep the first one the API sent. */
function mostUrgentByPlant(tasks: readonly TaskWithCoverage[]): Map<string, TaskWithCoverage> {
  const out = new Map<string, TaskWithCoverage>();
  for (const task of tasks) {
    const prev = out.get(task.plantId);
    if (!prev || Date.parse(task.nextDue) < Date.parse(prev.nextDue)) out.set(task.plantId, task);
  }
  return out;
}

export function plantCare(
  plants: readonly Plant[],
  tasks: readonly TaskWithCoverage[],
  now: Date = new Date()
): PlantCare[] {
  const urgent = mostUrgentByPlant(tasks);
  return plants.map((plant) => {
    const task = urgent.get(plant.id);
    if (!task) return { plant, bucket: 'none' };
    const days = calendarDaysBetween(now, new Date(task.nextDue));
    const bucket: CareBucket = days <= 0 ? 'needs' : days <= SOON_DAYS ? 'soon' : 'later';
    return { plant, task, days, bucket };
  });
}

const byName = (a: PlantCare, b: PlantCare) => a.plant.name.localeCompare(b.plant.name);
/** Most urgent first; plants due the same day by name. `none` sorts last. */
export const byUrgency = (a: PlantCare, b: PlantCare) =>
  (a.days ?? Infinity) - (b.days ?? Infinity) || byName(a, b);

export interface CareSection {
  /** `needs` | `soon` | `later` | `none` for care grouping; a space id,
   *  `unplaced`, or `all` for the other groupings. */
  id: string;
  items: PlantCare[];
}

export type GroupBy = 'care' | 'room' | 'name';

/**
 * Sections for the list, in display order, empty sections dropped.
 * `roomOf` names a plant's room key and `roomOrder` lists the keys in the
 * order the household's spaces come back (unplaced last).
 */
export function groupPlantCare(
  items: readonly PlantCare[],
  groupBy: GroupBy,
  roomOf: (plant: Plant) => string,
  roomOrder: readonly string[]
): CareSection[] {
  if (groupBy === 'name') return [{ id: 'all', items: [...items].sort(byName) }];
  if (groupBy === 'room') {
    const rooms = new Map<string, PlantCare[]>();
    for (const item of items) {
      const key = roomOf(item.plant);
      rooms.set(key, [...(rooms.get(key) ?? []), item]);
    }
    const keys = [...rooms.keys()].sort(
      (a, b) => rank(roomOrder, a) - rank(roomOrder, b) || a.localeCompare(b)
    );
    return keys.map((id) => ({ id, items: rooms.get(id)!.sort(byUrgency) }));
  }
  return (['needs', 'soon', 'later', 'none'] as const)
    .map((id) => ({
      id,
      items: items.filter((i) => i.bucket === id).sort(id === 'none' ? byName : byUrgency),
    }))
    .filter((s) => s.items.length > 0);
}

function rank(order: readonly string[], key: string): number {
  const i = order.indexOf(key);
  return i === -1 ? order.length : i;
}

/** Who has this task, as the row says it. `coveringFor` is the away
 *  assignee's name when someone is covering (vacation handoff). */
export type CareWho =
  | { kind: 'open' }
  | { kind: 'you'; coveringFor: string | null }
  | { kind: 'member'; name: string | null; coveringFor: string | null };

/**
 * The person doing the task right now. A vacation window does not rewrite
 * `assignedTo`; the backend adds `effectiveAssignee` for the covering member,
 * so that wins, or the row would name someone who is away.
 */
export function careWho(task: TaskWithCoverage, myUserId: string | undefined): CareWho {
  const id = task.effectiveAssignee ?? task.assignedTo;
  if (!id) return { kind: 'open' };
  const coveringFor = task.coveringFor ?? null;
  if (myUserId && id === myUserId) return { kind: 'you', coveringFor };
  // Assigned but the name did not come back: still assigned, never "open".
  const name = (task.effectiveAssignee ? task.effectiveAssigneeName : task.assignedToName) || null;
  return { kind: 'member', name, coveringFor };
}
