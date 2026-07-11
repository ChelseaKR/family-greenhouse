import { api } from './api';
import { Task } from './plantService';
import { track } from './analytics';

export interface CreateTaskData {
  plantId: string;
  type: 'water' | 'fertilize' | 'prune' | 'repot' | 'custom';
  customType?: string;
  frequency: number;
  assignedTo?: string;
  notes?: string;
  nextDue?: string;
}

export interface UpdateTaskData {
  type?: 'water' | 'fertilize' | 'prune' | 'repot' | 'custom';
  customType?: string;
  frequency?: number;
  assignedTo?: string | null;
  notes?: string;
  nextDue?: string;
}

export interface CompleteTaskData {
  notes?: string;
}

export interface TaskFilters {
  plantId?: string;
  assignedTo?: string;
  dueWithin?: number; // days
  overdue?: boolean;
}

/**
 * Pick the most specific curated task bundle for a species name. Unknown
 * species deliberately return undefined so the UI never invents a schedule.
 */
export function suggestTaskTemplate(
  templates: TaskTemplate[],
  species: string | null | undefined
): TaskTemplate | undefined {
  const normalized = species?.trim().toLowerCase();
  if (!normalized) return undefined;

  let bestMatch: { template: TaskTemplate; score: number } | undefined;
  for (const template of templates) {
    const score = template.suitsKeywords.reduce(
      (total, keyword) => total + (normalized.includes(keyword.toLowerCase()) ? 1 : 0),
      0
    );
    if (score > 0 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { template, score };
    }
  }
  return bestMatch?.template;
}

/** Why a snooze happened — mirrored from backend snoozeReasonEnum. */
export type SnoozeReason = 'rain' | 'frost' | 'heat' | 'other';

/**
 * Task plus the read-time vacation annotation the backend adds when the
 * assignee has an active vacation window. `assignedTo` is never rewritten;
 * these fields simply disappear when the window expires.
 */
export interface TaskWithCoverage extends Task {
  effectiveAssignee?: string;
  effectiveAssigneeName?: string | null;
  /** Name of the away assignee — drives the "Covering for X" badge. */
  coveringFor?: string | null;
}

/** Vacation window (care handoff), one per member. */
export interface VacationWindow {
  householdId: string;
  userId: string;
  coveredBy: string;
  coveredByName: string | null;
  startDate: string;
  endDate: string;
  createdBy: string;
  createdAt: string;
}

export interface SetVacationData {
  /** Defaults to the caller; setting for someone else requires admin. */
  userId?: string;
  coveredBy: string;
  startDate: string;
  endDate: string;
}

export const taskService = {
  async getTasks(filters?: TaskFilters): Promise<TaskWithCoverage[]> {
    // axios serializes `params` (skipping undefined), so we don't hand-build
    // the query string.
    const params: Record<string, string | number | boolean> = {};
    if (filters?.plantId) params.plantId = filters.plantId;
    if (filters?.assignedTo) params.assignedTo = filters.assignedTo;
    if (filters?.dueWithin) params.dueWithin = filters.dueWithin;
    if (filters?.overdue !== undefined) params.overdue = filters.overdue;

    const response = await api.get<TaskWithCoverage[]>('/tasks', { params });
    return response.data;
  },

  async getUpcomingTasks(): Promise<TaskWithCoverage[]> {
    const response = await api.get<TaskWithCoverage[]>('/tasks/upcoming');
    return response.data;
  },

  async getTask(id: string): Promise<Task> {
    const response = await api.get<Task>(`/tasks/${id}`);
    return response.data;
  },

  async createTask(data: CreateTaskData): Promise<Task> {
    const response = await api.post<Task>('/tasks', data);
    track('task_created', { taskType: data.type });
    return response.data;
  },

  async updateTask(id: string, data: UpdateTaskData): Promise<Task> {
    const response = await api.put<Task>(`/tasks/${id}`, data);
    return response.data;
  },

  async deleteTask(id: string): Promise<void> {
    await api.delete(`/tasks/${id}`);
  },

  async completeTask(id: string, data?: CompleteTaskData): Promise<Task> {
    const response = await api.post<Task>(`/tasks/${id}/complete`, data || {});
    track('task_completed', {
      taskType: response.data.type as 'water' | 'fertilize' | 'prune' | 'repot' | 'custom',
    });
    return response.data;
  },

  async snoozeTask(
    id: string,
    days: number,
    opts?: { reason?: SnoozeReason; note?: string }
  ): Promise<Task> {
    const body: Record<string, unknown> = { days };
    if (opts?.reason) body.reason = opts.reason;
    if (opts?.note) body.note = opts.note;
    const response = await api.post<Task>(`/tasks/${id}/snooze`, body);
    track('task_snoozed');
    return response.data;
  },

  /** Take an unassigned ("up for grabs") task. 409 = someone beat you to it. */
  async claimTask(id: string): Promise<Task> {
    const response = await api.post<Task>(`/tasks/${id}/claim`, {});
    return response.data;
  },

  /** Release a task you're assigned to. */
  async unclaimTask(id: string): Promise<Task> {
    const response = await api.post<Task>(`/tasks/${id}/unclaim`, {});
    return response.data;
  },

  // --- Vacation windows (care handoff) ---

  async getVacationWindows(): Promise<VacationWindow[]> {
    const response = await api.get<VacationWindow[]>('/tasks/vacation');
    return response.data;
  },

  async setVacation(data: SetVacationData): Promise<VacationWindow> {
    const response = await api.put<VacationWindow>('/tasks/vacation', data);
    return response.data;
  },

  async cancelVacation(userId: string): Promise<void> {
    await api.delete(`/tasks/vacation/${userId}`);
  },

  async listTemplates(): Promise<TaskTemplate[]> {
    const response = await api.get<TaskTemplate[]>('/tasks/templates');
    return response.data;
  },

  async applyTemplate(plantId: string, templateId: string): Promise<{ created: Task[] }> {
    const response = await api.post<{ created: Task[] }>(`/plants/${plantId}/apply-template`, {
      templateId,
    });
    return response.data;
  },

  async applyTemplateBulk(
    plantIds: string[],
    templateId: string
  ): Promise<{
    applied: Array<{ plantId: string; taskIds: string[] }>;
    skipped: Array<{ plantId: string; reason: string }>;
  }> {
    const response = await api.post('/plants/apply-template-bulk', {
      plantIds,
      templateId,
    });
    return response.data;
  },
};

export interface TaskTemplate {
  id: string;
  name: string;
  description: string;
  suitsKeywords: string[];
  tasks: Array<{
    type: 'water' | 'fertilize' | 'prune' | 'repot' | 'custom';
    customType?: string;
    frequencyDays: number;
    notes?: string;
  }>;
}
