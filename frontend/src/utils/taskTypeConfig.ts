import { WaterDropIcon } from '@/components/icons/WaterDropIcon';
import { FertilizeIcon } from '@/components/icons/FertilizeIcon';
import { PruneIcon } from '@/components/icons/PruneIcon';
import { RepotIcon } from '@/components/icons/RepotIcon';
import { CustomTaskIcon } from '@/components/icons/CustomTaskIcon';

/**
 * Single source of truth for how each task type is labelled and styled.
 *
 * These maps used to be copy-pasted (byte-identical) across TasksPage,
 * DashboardPage, and PlantDetailPage — so adding a task type or retinting a
 * chip meant editing three files and risked drift. Centralizing here keeps
 * the journal palette consistent and makes the type set extendable in one
 * place.
 */
export const taskTypeLabels: Record<string, string> = {
  water: 'Water',
  fertilize: 'Fertilize',
  prune: 'Prune',
  repot: 'Repot',
  custom: 'Custom',
};

export interface TaskTypeStyle {
  Icon: (p: { className?: string }) => JSX.Element;
  /** Soft brand-tinted chip background + ring (no raw Tailwind primaries). */
  chip: string;
  iconColor: string;
}

export const taskTypeStyles: Record<string, TaskTypeStyle> = {
  water: {
    Icon: WaterDropIcon,
    chip: 'bg-sky-50 text-sky-900 ring-sky-200/70',
    iconColor: 'text-sky-700',
  },
  fertilize: {
    Icon: FertilizeIcon,
    chip: 'bg-primary-50 text-primary-900 ring-primary-200/70',
    iconColor: 'text-primary-700',
  },
  prune: {
    Icon: PruneIcon,
    chip: 'bg-accent-50 text-accent-900 ring-accent-200/70',
    iconColor: 'text-accent-700',
  },
  repot: {
    Icon: RepotIcon,
    chip: 'bg-amber-50 text-amber-900 ring-amber-200/70',
    iconColor: 'text-amber-800',
  },
  custom: {
    Icon: CustomTaskIcon,
    chip: 'bg-stone-100 text-stone-900 ring-stone-200/70',
    iconColor: 'text-stone-700',
  },
};

/** Human label for a task type, falling back to the raw key. */
export function taskTypeLabel(type: string): string {
  return taskTypeLabels[type] ?? type;
}

/** Style entry for a task type, falling back to the `custom` styling. */
export function taskTypeStyle(type: string): TaskTypeStyle {
  return taskTypeStyles[type] ?? taskTypeStyles.custom;
}
