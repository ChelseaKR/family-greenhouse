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

export const taskService = {
  async getTasks(filters?: TaskFilters): Promise<Task[]> {
    const params = new URLSearchParams();
    if (filters?.plantId) params.set('plantId', filters.plantId);
    if (filters?.assignedTo) params.set('assignedTo', filters.assignedTo);
    if (filters?.dueWithin) params.set('dueWithin', filters.dueWithin.toString());
    if (filters?.overdue !== undefined) params.set('overdue', filters.overdue.toString());

    const response = await api.get<Task[]>(`/tasks?${params.toString()}`);
    return response.data;
  },

  async getUpcomingTasks(): Promise<Task[]> {
    const response = await api.get<Task[]>('/tasks/upcoming');
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

  async snoozeTask(id: string, days: number): Promise<Task> {
    const response = await api.post<Task>(`/tasks/${id}/snooze`, { days });
    track('task_snoozed');
    return response.data;
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
