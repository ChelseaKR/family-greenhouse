export const TASK_TYPES = ['water', 'fertilize', 'prune', 'repot', 'custom'] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  water: 'Water',
  fertilize: 'Fertilize',
  prune: 'Prune',
  repot: 'Repot',
  custom: 'Custom',
};

export const TASK_TYPE_COLORS: Record<TaskType, string> = {
  water: 'bg-blue-100 text-blue-900',
  fertilize: 'bg-green-100 text-green-900',
  prune: 'bg-orange-100 text-orange-900',
  repot: 'bg-purple-100 text-purple-900',
  custom: 'bg-gray-100 text-gray-900',
};

export const DEFAULT_FREQUENCIES: Record<Exclude<TaskType, 'custom'>, number> = {
  water: 7,
  fertilize: 30,
  prune: 90,
  repot: 365,
};
