import type { ActivityEvent } from '@/services/householdService';

const SHARED_CARE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type SharedCareMilestoneKey = 'plant' | 'task' | 'teammate' | 'sharedCare';

export interface SharedCareMilestone {
  key: SharedCareMilestoneKey;
  completed: boolean;
}

interface SharedCareInputs {
  plantCount: number;
  taskCount: number;
  memberUserIds: string[];
  activity: ActivityEvent[];
  currentUserId: string | null;
  now?: number;
}

/**
 * Derive the four collaboration milestones from household facts rather than
 * storing a second, drift-prone checklist. The final milestone is deliberately
 * time-bound: a teammate joining proves access, while a teammate completing a
 * task recently proves that the shared-care handoff is still working.
 */
export function deriveSharedCareMilestones({
  plantCount,
  taskCount,
  memberUserIds,
  activity,
  currentUserId,
  now = Date.now(),
}: SharedCareInputs): SharedCareMilestone[] {
  const recentCutoff = now - SHARED_CARE_WINDOW_MS;
  const teammateIds = new Set(memberUserIds.filter((userId) => userId !== currentUserId));
  const teammateCompletedCare =
    currentUserId != null &&
    activity.some((event) => {
      if (event.type !== 'task.completed' || !teammateIds.has(event.actorId)) return false;
      const occurredAt = Date.parse(event.occurredAt);
      return Number.isFinite(occurredAt) && occurredAt >= recentCutoff;
    });

  return [
    { key: 'plant', completed: plantCount > 0 },
    { key: 'task', completed: taskCount > 0 },
    { key: 'teammate', completed: teammateIds.size > 0 },
    { key: 'sharedCare', completed: teammateIds.size > 0 && teammateCompletedCare },
  ];
}
