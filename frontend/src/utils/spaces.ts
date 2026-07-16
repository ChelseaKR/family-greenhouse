import type { Plant, PlantSpace } from '@/services/plantService';

export type SpaceFilter = 'all' | 'inside' | 'outside' | 'unplaced';

export function spaceMap(spaces: PlantSpace[]): Map<string, PlantSpace> {
  return new Map(spaces.map((space) => [space.id, space]));
}

export function plantSpace(plant: Plant, spaces: Map<string, PlantSpace>): PlantSpace | undefined {
  return plant.spaceId ? spaces.get(plant.spaceId) : undefined;
}

export function plantLocationLabel(
  plant: Plant,
  spaces: Map<string, PlantSpace>,
  unplacedLabel = 'Unplaced'
): string {
  const current = plantSpace(plant, spaces);
  if (current)
    return plant.placementNote ? `${current.name} · ${plant.placementNote}` : current.name;
  return plant.location || unplacedLabel;
}

export function matchesSpaceFilter(
  plant: Plant,
  spaces: Map<string, PlantSpace>,
  filter: SpaceFilter
): boolean {
  if (filter === 'all') return true;
  const current = plantSpace(plant, spaces);
  if (filter === 'unplaced') return !current;
  return current?.environment === filter;
}
