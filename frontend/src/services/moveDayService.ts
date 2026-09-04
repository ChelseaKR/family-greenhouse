import { api } from './api';

export type MoveDaySeason = 'winter' | 'summer';

export interface MoveDayItem {
  plantId: string;
  plantName: string;
  fromSpaceId: string | null;
  fromSpaceName: string | null;
  toSpaceId: string;
  toSpaceName: string;
  assigneeId: string | null;
  assigneeName: string | null;
  taskId: string | null;
}

export interface MoveDayTenderPlant {
  plantId: string;
  plantName: string;
  hardinessZone: string;
}

export interface MoveDayList {
  season: MoveDaySeason;
  firedAt: string;
  /** The measured numbers that fired the list and the lines they crossed —
   *  the card renders these, never a number of its own. */
  signal: { tempC: number; lowC: number; frostLineC: number; heatLineC: number };
  items: MoveDayItem[];
  /** Winter only; presence-only (see backend services/moveDayPlan.ts). */
  tenderWithoutWinterHome: MoveDayTenderPlant[];
}

/**
 * Every status other than `ready` is rendered as silence by design: the
 * plan lacks the feature, the household has nothing seasonal, no live
 * snapshot exists (nothing is inferred), or nothing is out of place.
 */
export type MoveDayResult =
  | { status: 'locked' }
  | { status: 'not_applicable' }
  | { status: 'unavailable' }
  | { status: 'quiet' }
  | { status: 'ready'; list: MoveDayList };

export const moveDayService = {
  /**
   * Evaluate Seasonal Move Day. POST because the first call after a frost/heat
   * line is crossed creates the move tasks; it is idempotent per season.
   */
  async evaluate(householdId: string): Promise<MoveDayResult> {
    const response = await api.post<MoveDayResult>(`/households/${householdId}/move-day`);
    return response.data;
  },
};
