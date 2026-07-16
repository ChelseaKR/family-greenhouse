import type { PlantSpace } from '@/services/plantService';

export type LightLevel = NonNullable<PlantSpace['lightLevel']>;

export interface PlacementCareProfile {
  minimumLight?: LightLevel | null;
  toxicToPets?: boolean | null;
}

export type PlacementFitCheck =
  { type: 'light'; current: LightLevel; recommended: LightLevel } | { type: 'pet' };

const LIGHT_RANK: Record<LightLevel, number> = { low: 0, medium: 1, bright: 2 };

/**
 * Convert provider sunlight labels into the broad room-light scale used by
 * spaces. Prefer the lowest explicitly supported level so prompts remain
 * conservative rather than treating every mention of full sun as a demand.
 */
export function minimumLightFromSunlight(values: string[]): LightLevel | null {
  const sunlight = values.join(' ').toLowerCase();
  if (!sunlight) return null;
  if (/full shade|deep shade|low light/.test(sunlight)) return 'low';
  if (/part shade|partial shade|filtered shade|indirect|medium/.test(sunlight)) return 'medium';
  if (/full sun|direct|bright/.test(sunlight)) return 'bright';
  return null;
}

export function placementFitChecks(
  space: PlantSpace | null | undefined,
  profile: PlacementCareProfile
): PlacementFitCheck[] {
  if (!space) return [];
  const checks: PlacementFitCheck[] = [];

  if (
    space.lightLevel &&
    profile.minimumLight &&
    LIGHT_RANK[space.lightLevel] < LIGHT_RANK[profile.minimumLight]
  ) {
    checks.push({
      type: 'light',
      current: space.lightLevel,
      recommended: profile.minimumLight,
    });
  }
  if (space.petAccess === true && profile.toxicToPets === true) {
    checks.push({ type: 'pet' });
  }

  return checks;
}
