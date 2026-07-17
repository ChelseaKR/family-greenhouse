import type { HouseholdMember } from '@/services/householdService';
import type { Plant, PlantSpace } from '@/services/plantService';
import type { TaskWithCoverage } from '@/services/taskService';
import { calendarDaysBetween } from '@/utils/date';
import { seasonalHomeSuggestion } from './seasonalHomes';

export interface SeasonalMoveSummary {
  plantId: string;
  plantName: string;
  targetSpaceId: string;
  targetSpaceName: string;
}

export interface SpaceOverviewGroup {
  id: string;
  name: string;
  environment: PlantSpace['environment'] | 'unplaced';
  space: PlantSpace | null;
  plants: Plant[];
  taskCount: number;
  overdueCount: number;
  todayCount: number;
  nextDue: string | null;
  caregiverName: string | null;
  seasonalMoves: SeasonalMoveSummary[];
}

const environmentRank: Record<SpaceOverviewGroup['environment'], number> = {
  inside: 0,
  outside: 1,
  unplaced: 2,
};

/**
 * Join the existing plant, space, task, and household projections into a
 * route-shaped overview. This stays client-side so the overview cannot drift
 * from the task list or require a denormalized summary row to maintain.
 */
export function buildSpaceOverviewGroups(
  plants: Plant[],
  spaces: PlantSpace[],
  tasks: TaskWithCoverage[],
  members: HouseholdMember[] = [],
  latitude?: number | null,
  now = new Date()
): SpaceOverviewGroup[] {
  const spaceById = new Map(spaces.map((space) => [space.id, space]));
  const memberById = new Map(members.map((member) => [member.userId, member.name]));
  const plantsByGroup = new Map<string, Plant[]>();

  for (const plant of plants) {
    const groupId = plant.spaceId && spaceById.has(plant.spaceId) ? plant.spaceId : 'unplaced';
    const groupPlants = plantsByGroup.get(groupId) ?? [];
    groupPlants.push(plant);
    plantsByGroup.set(groupId, groupPlants);
  }

  return [...plantsByGroup.entries()]
    .map(([id, groupPlants]): SpaceOverviewGroup => {
      const space = id === 'unplaced' ? null : (spaceById.get(id) ?? null);
      const plantIds = new Set(groupPlants.map((plant) => plant.id));
      const groupTasks = tasks
        .filter((task) => plantIds.has(task.plantId))
        .sort((a, b) => new Date(a.nextDue).getTime() - new Date(b.nextDue).getTime());
      const dayOffsets = groupTasks.map((task) => calendarDaysBetween(now, new Date(task.nextDue)));
      const seasonalMoves = groupPlants.flatMap((plant): SeasonalMoveSummary[] => {
        const suggestion = seasonalHomeSuggestion(plant, spaces, latitude, now);
        return suggestion
          ? [
              {
                plantId: plant.id,
                plantName: plant.name,
                targetSpaceId: suggestion.targetSpace.id,
                targetSpaceName: suggestion.targetSpace.name,
              },
            ]
          : [];
      });

      return {
        id,
        name: space?.name ?? 'Unplaced',
        environment: space?.environment ?? 'unplaced',
        space,
        plants: [...groupPlants].sort((a, b) => a.name.localeCompare(b.name)),
        taskCount: groupTasks.length,
        overdueCount: dayOffsets.filter((offset) => offset < 0).length,
        todayCount: dayOffsets.filter((offset) => offset === 0).length,
        nextDue: groupTasks[0]?.nextDue ?? null,
        caregiverName: space?.defaultCaregiverId
          ? (memberById.get(space.defaultCaregiverId) ?? null)
          : null,
        seasonalMoves,
      };
    })
    .sort(
      (a, b) =>
        environmentRank[a.environment] - environmentRank[b.environment] ||
        a.name.localeCompare(b.name)
    );
}
