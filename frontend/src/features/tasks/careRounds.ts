import type { Plant, PlantSpace } from '@/services/plantService';
import type { TaskWithCoverage } from '@/services/taskService';
import { calendarDaysBetween } from '@/utils/date';

export interface CareRoundGroup {
  id: string;
  name: string;
  environment: PlantSpace['environment'] | 'unplaced';
  tasks: TaskWithCoverage[];
}

const environmentRank: Record<CareRoundGroup['environment'], number> = {
  inside: 0,
  outside: 1,
  unplaced: 2,
};

/** Build a stable physical route: inside spaces, outside spaces, then
 * unplaced work. Tasks retain the due-date ordering supplied by the caller. */
export function buildCareRoundGroups(
  tasks: TaskWithCoverage[],
  plants: Plant[],
  spaces: PlantSpace[],
  unplacedName = 'Unplaced'
): CareRoundGroup[] {
  const plantById = new Map(plants.map((plant) => [plant.id, plant]));
  const spaceById = new Map(spaces.map((space) => [space.id, space]));
  const groups = new Map<string, CareRoundGroup>();

  for (const task of tasks) {
    const plant = plantById.get(task.plantId);
    const space = plant?.spaceId ? spaceById.get(plant.spaceId) : undefined;
    const id = space?.id ?? 'unplaced';
    const group = groups.get(id) ?? {
      id,
      name: space?.name ?? unplacedName,
      environment: space?.environment ?? 'unplaced',
      tasks: [],
    };
    group.tasks.push(task);
    groups.set(id, group);
  }

  return [...groups.values()].sort(
    (a, b) =>
      environmentRank[a.environment] - environmentRank[b.environment] ||
      a.name.localeCompare(b.name)
  );
}

/** Scope a task list to one current household space. Missing/deleted space
 * references intentionally join the explicit Unplaced bucket. */
export function filterTasksForSpace(
  tasks: TaskWithCoverage[],
  plants: Plant[],
  spaces: PlantSpace[],
  spaceId: string | null
): TaskWithCoverage[] {
  if (!spaceId) return tasks;

  const plantById = new Map(plants.map((plant) => [plant.id, plant]));
  const knownSpaceIds = new Set(spaces.map((space) => space.id));

  return tasks.filter((task) => {
    const plantSpaceId = plantById.get(task.plantId)?.spaceId;
    if (spaceId === 'unplaced') {
      return !plantSpaceId || !knownSpaceIds.has(plantSpaceId);
    }
    return plantSpaceId === spaceId && knownSpaceIds.has(spaceId);
  });
}

/**
 * The round starts where the most overdue work is: rooms sorted by their
 * most urgent task (calendar days, so the time of day a task is stored with
 * never decides), keeping the physical route order between rooms that are
 * equally urgent. Each group's tasks must already be sorted by due date.
 */
export function mostOverdueFirst(
  groups: readonly CareRoundGroup[],
  now: Date = new Date()
): CareRoundGroup[] {
  const firstDue = (group: CareRoundGroup) =>
    group.tasks.length > 0
      ? calendarDaysBetween(now, new Date(group.tasks[0].nextDue))
      : Number.POSITIVE_INFINITY;
  return [...groups].sort((a, b) => firstDue(a) - firstDue(b));
}
