import type { Plant, PlantSpace } from '@/services/plantService';

export type SeasonalHomeSeason = 'summer' | 'winter';

/**
 * Treat April–September as the northern warm season and invert it south of
 * the equator. The broad windows make the prompt useful before temperature
 * extremes arrive without pretending to be a weather forecast.
 */
export function seasonForMonth(latitude: number, month: number): SeasonalHomeSeason {
  const northernSummer = month >= 3 && month <= 8;
  const localSummer = latitude < 0 ? !northernSummer : northernSummer;
  return localSummer ? 'summer' : 'winter';
}

export interface SeasonalHomeSuggestion {
  season: SeasonalHomeSeason;
  targetSpace: PlantSpace;
}

export function seasonalHomeSuggestion(
  plant: Pick<Plant, 'spaceId' | 'summerSpaceId' | 'winterSpaceId'> | null | undefined,
  spaces: PlantSpace[],
  latitude: number | null | undefined,
  date = new Date()
): SeasonalHomeSuggestion | null {
  if (!plant || latitude == null || !Number.isFinite(latitude)) return null;

  const season = seasonForMonth(latitude, date.getMonth());
  const targetSpaceId = season === 'summer' ? plant.summerSpaceId : plant.winterSpaceId;
  if (!targetSpaceId || targetSpaceId === plant.spaceId) return null;

  const targetSpace = spaces.find((space) => space.id === targetSpaceId);
  return targetSpace ? { season, targetSpace } : null;
}
