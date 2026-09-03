import { api } from './api';
import { track } from './analytics';

export interface Household {
  id: string;
  name: string;
  /** Optional saved location for climate-aware care tips. */
  location?: { city: string; lat: number; lon: number } | null;
  createdAt: string;
  createdBy: string;
}

// Note: the household detail endpoint (GET /households/:id) never includes
// email on member rows — other household members "cannot see your email"
// per the Privacy Policy, with no admin exception.
export interface HouseholdMember {
  userId: string;
  name: string;
  role: 'admin' | 'member';
  joinedAt: string;
}

export interface HouseholdWithMembers extends Household {
  members: HouseholdMember[];
}

export interface CreateHouseholdData {
  name: string;
}

export interface InviteLink {
  code: string;
  expiresAt: string;
  url: string;
}

export interface JoinHouseholdData {
  inviteCode: string;
}

/** The non-secret view of a sitter link (list/management). No token. */
export interface SitterLinkSummary {
  id: string;
  householdId: string;
  createdBy: string;
  createdAt: string;
  startsAt: string;
  expiresAt: string;
  status: 'active' | 'revoked';
  label: string | null;
}

/** The create response — the ONLY time the token + URL are exposed. */
export interface CreatedSitterLink extends SitterLinkSummary {
  token: string;
  url: string;
}

export interface CreateSitterLinkData {
  expiresAt: string;
  startsAt?: string;
  label?: string;
}

/** A sitter link opened or closed — the non-secret id, label and window.
 *  Never the token. Mirrors the backend payload. */
export interface SitterLinkActivityPayload {
  linkId: string;
  label: string | null;
  startsAt: string;
  expiresAt: string;
}

export const householdService = {
  async getHousehold(id: string): Promise<HouseholdWithMembers> {
    const response = await api.get<HouseholdWithMembers>(`/households/${id}`);
    return response.data;
  },

  async createHousehold(data: CreateHouseholdData): Promise<Household> {
    const response = await api.post<Household>('/households', data);
    return response.data;
  },

  async createInvite(householdId: string): Promise<InviteLink> {
    const response = await api.post<InviteLink>(`/households/${householdId}/invites`);
    track('invite_sent');
    return response.data;
  },

  async joinHousehold(householdId: string, data: JoinHouseholdData): Promise<Household> {
    const response = await api.post<Household>(`/households/${householdId}/join`, data);
    return response.data;
  },

  async validateInvite(inviteCode: string): Promise<{ household: Household; valid: boolean }> {
    const response = await api.get<{ household: Household; valid: boolean }>(
      `/households/invites/${inviteCode}`
    );
    return response.data;
  },

  async joinWithInvite(inviteCode: string): Promise<Household> {
    const response = await api.post<Household>(`/households/join/${inviteCode}`);
    return response.data;
  },

  async removeMember(householdId: string, userId: string): Promise<void> {
    await api.delete(`/households/${householdId}/members/${userId}`);
  },

  async updateMemberRole(
    householdId: string,
    userId: string,
    role: 'admin' | 'member'
  ): Promise<HouseholdMember> {
    const response = await api.put<HouseholdMember>(
      `/households/${householdId}/members/${userId}/role`,
      { role }
    );
    return response.data;
  },

  async createSitterLink(
    householdId: string,
    data: CreateSitterLinkData
  ): Promise<CreatedSitterLink> {
    const response = await api.post<CreatedSitterLink>(
      `/households/${householdId}/sitter-links`,
      data
    );
    return response.data;
  },

  async listSitterLinks(householdId: string): Promise<SitterLinkSummary[]> {
    const response = await api.get<SitterLinkSummary[]>(`/households/${householdId}/sitter-links`);
    return response.data;
  },

  async revokeSitterLink(householdId: string, linkId: string): Promise<void> {
    await api.delete(`/households/${householdId}/sitter-links/${linkId}`);
  },

  async getActivity(householdId: string, limit = 50): Promise<ActivityEvent[]> {
    const response = await api.get<ActivityEvent[]>(
      `/households/${householdId}/activity?limit=${limit}`
    );
    return response.data;
  },

  async getYearInReview(householdId: string, year: number): Promise<YearInReview> {
    const response = await api.get<YearInReview>(
      `/households/${householdId}/year-in-review?year=${year}`
    );
    return response.data;
  },

  async getDailyAnalytics(householdId: string, days = 30): Promise<DailyAnalytics> {
    const response = await api.get<DailyAnalytics>(
      `/households/${householdId}/analytics/daily?days=${days}`
    );
    return response.data;
  },
};

export interface DailyAnalytics {
  days: number;
  series: Array<{ date: string; count: number }>;
}

export interface TaskCompletedActivityPayload {
  taskId: string;
  plantId: string;
  plantName?: string;
  taskType: string;
  notes?: string | null;
  viaSitter?: boolean;
}

export interface TaskSnoozedActivityPayload {
  taskId: string;
  plantId: string;
  plantName: string;
  taskType: string;
  days: number;
  reason: 'rain' | 'frost' | 'heat' | 'other' | null;
  note: string | null;
}

export interface TaskAssignmentActivityPayload {
  taskId: string;
  plantId: string;
  plantName: string;
  taskType: string;
}

export interface PlantIdentityActivityPayload {
  plantId: string;
  plantName: string;
}

export interface PlantLifecycleActivityPayload extends PlantIdentityActivityPayload {
  previousStatus?: 'active' | 'died' | 'gave_away' | 'archived';
}

/**
 * Payload contract keyed by the durable event discriminator. The API client
 * and dashboard renderer both consume the discriminated union derived from
 * this map, while their runtime fallbacks still tolerate older or newer rows.
 */
export interface ActivityPayloadByType {
  'task.completed': TaskCompletedActivityPayload;
  'task.snoozed': TaskSnoozedActivityPayload;
  'task.claimed': TaskAssignmentActivityPayload;
  'task.unclaimed': TaskAssignmentActivityPayload;
  'plant.created': PlantIdentityActivityPayload;
  'plants.imported': { count: number };
  'plant.deleted': PlantIdentityActivityPayload;
  'plant.died': PlantLifecycleActivityPayload;
  'plant.gave_away': PlantLifecycleActivityPayload;
  'plant.archived': PlantLifecycleActivityPayload;
  'plant.restored': PlantLifecycleActivityPayload;
  'plant.propagated': PlantIdentityActivityPayload & {
    parentPlantId: string;
    parentPlantName: string;
  };
  'plant.shared_accepted': PlantIdentityActivityPayload & { fromHouseholdName: string };
  'plant.health_checked': PlantIdentityActivityPayload & {
    overall: 'healthy' | 'monitor' | 'concern';
    demo: boolean;
  };
  'photo.uploaded': { plantId: string; photoId: string };
  'member.joined': { role: 'admin' | 'member' };
  'member.left': { role?: 'admin' | 'member' };
  'sitter_link.created': SitterLinkActivityPayload;
  'sitter_link.revoked': SitterLinkActivityPayload;
}

export type ActivityType = keyof ActivityPayloadByType;

/** Runtime vocabulary kept in mechanical parity with the backend list. */
export const ACTIVITY_TYPES = [
  'task.completed',
  'task.snoozed',
  'task.claimed',
  'task.unclaimed',
  'plant.created',
  'plants.imported',
  'plant.deleted',
  'plant.died',
  'plant.gave_away',
  'plant.archived',
  'plant.restored',
  'plant.propagated',
  'plant.shared_accepted',
  'plant.health_checked',
  'photo.uploaded',
  'member.joined',
  'member.left',
  'sitter_link.created',
  'sitter_link.revoked',
] as const satisfies readonly ActivityType[];

type AssertNever<T extends never> = T;
export type ActivityTypeListIsComplete = AssertNever<
  Exclude<ActivityType, (typeof ACTIVITY_TYPES)[number]>
>;

interface ActivityEventEnvelope {
  id: string;
  householdId: string;
  actorId: string;
  actorName: string;
  occurredAt: string;
}

export type ActivityEventByType<T extends ActivityType> = ActivityEventEnvelope & {
  type: T;
  payload: ActivityPayloadByType[T];
};

export type ActivityEvent = {
  [T in ActivityType]: ActivityEventByType<T>;
}[ActivityType];

export interface Membership {
  householdId: string;
  name: string;
  role: 'admin' | 'member';
  joinedAt: string;
}

/**
 * Standalone helper for the household-switcher — lives outside the main
 * `householdService` object because it's about the *user's* memberships,
 * not a single household.
 */
export async function listMyHouseholds(): Promise<Membership[]> {
  const response = await api.get<Membership[]>('/me/households');
  return response.data;
}

export interface YearInReview {
  year: number;
  totalCompletions: number;
  byMember: Array<{ userId: string; name: string; count: number }>;
  byTaskType: Array<{ type: string; count: number }>;
  /** Every plant with ≥1 completion this year, most-completed first — NOT a
   *  capped top-N, so absence from this list is a genuine zero. */
  topPlants: Array<{ plantId: string; count: number }>;
}
