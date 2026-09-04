/**
 * Cross-home Today (ADR 0017): the caller's due-today and overdue work
 * across every household they belong to, GROUPED BY HOUSEHOLD with the
 * household name on every row. Never a merged plant list.
 *
 * The read is not pinned to the active household. Acting on a row goes
 * back through the ordinary single-household task routes with an explicit
 * `X-Household-Id` for THAT row's home — the request interceptor in
 * `api.ts` leaves an explicit header alone instead of overwriting it with
 * the active-household pin.
 */
import axios from 'axios';
import { api } from './api';
import { track } from './analytics';
import type { Task } from './plantService';
import type { TaskWithCoverage } from './taskService';

export type HouseholdRole = 'admin' | 'member';

/** One row of the queue: a household's task, labelled with its home. */
export interface CrossHomeTodayRow extends TaskWithCoverage {
  householdId: string;
  householdName: string;
}

export interface CrossHomeTodayHouseholdOk {
  householdId: string;
  name: string;
  role: HouseholdRole;
  status: 'ok';
  tasks: CrossHomeTodayRow[];
}

/**
 * A home whose read failed. It is an explicit entry — never dropped, never
 * an empty task list — because a missing group would read as "nothing due
 * there". `name` is null when even the household row could not be read.
 */
export interface CrossHomeTodayHouseholdUnavailable {
  householdId: string;
  name: string | null;
  role: HouseholdRole;
  status: 'unavailable';
}

export type CrossHomeTodayHousehold =
  CrossHomeTodayHouseholdOk | CrossHomeTodayHouseholdUnavailable;

export interface CrossHomeToday {
  generatedAt: string;
  cutoff: string;
  households: CrossHomeTodayHousehold[];
}

/** Not household-scoped, so the key deliberately carries no household id. */
export const CROSS_HOME_TODAY_QUERY_KEY = ['me', 'today'] as const;

/**
 * End of the caller's local calendar day. "Today" is the reader's day, not
 * the server's — the API takes it as `until` and bounds it to ±48h of now.
 */
export function endOfLocalDay(now: Date = new Date()): string {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end.toISOString();
}

/** A 402 from the endpoint: none of the caller's households includes the view. */
export function isPlanLocked(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 402;
}

function forHousehold(householdId: string) {
  return { headers: { 'X-Household-Id': householdId } };
}

export const crossHomeTodayService = {
  async get(until: string): Promise<CrossHomeToday> {
    const response = await api.get<CrossHomeToday>('/me/today', { params: { until } });
    return response.data;
  },

  /** Complete a row in ITS home. `expectedNextDue` keeps transport retries idempotent. */
  async completeTask(householdId: string, taskId: string, expectedNextDue: string): Promise<Task> {
    const response = await api.post<Task>(
      `/tasks/${taskId}/complete`,
      { expectedNextDue },
      forHousehold(householdId)
    );
    track('task_completed', {
      taskType: response.data.type as 'water' | 'fertilize' | 'prune' | 'repot' | 'custom',
    });
    return response.data;
  },

  /** Claim an up-for-grabs row in ITS home. 409 = someone beat you to it. */
  async claimTask(householdId: string, taskId: string): Promise<Task> {
    const response = await api.post<Task>(`/tasks/${taskId}/claim`, {}, forHousehold(householdId));
    return response.data;
  },

  /** Release a row you hold in ITS home. */
  async unclaimTask(householdId: string, taskId: string): Promise<Task> {
    const response = await api.post<Task>(
      `/tasks/${taskId}/unclaim`,
      {},
      forHousehold(householdId)
    );
    return response.data;
  },
};
