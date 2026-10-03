import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { CheckIcon, EllipsisHorizontalIcon, PlusIcon } from '@heroicons/react/24/outline';
import type { Plant, Task, TaskCompletion } from '@/services/plantService';
import { PlantImage } from '@/components/PlantImage';
import { Button } from '@/components/Button';
import { formatRelativeDay } from '@/i18n/format';
import { PlantStatusBadge } from './PlantLineageCard';
import { ToolbarMenu, type MenuGroupModel } from './ToolbarMenu';
import { careWho, plantCare } from './plantCare';
import { careStatusText } from './plantCareText';

interface PlantPageHeaderProps {
  plant: Plant & { upcomingTasks: Task[]; recentCompletions: TaskCompletion[] };
  location: string;
  myUserId: string | undefined;
  /** The "…" menu; drawn here on the website, in the bar in the app. */
  menu: MenuGroupModel[] | null;
  onMenu: (id: string) => void;
  onDone: (task: Task) => void;
  onClaim: (task: Task) => void;
  onAddTask: () => void;
  isCompleting: boolean;
  /** The plant page's own snooze control, for the most urgent task. */
  snooze: (task: Task) => ReactNode;
}

/**
 * The top of the plant page on a phone (the website under 640px and the
 * iOS app): the photo, the name, and one card with the thing to do now and
 * who has it, instead of a grid of nine buttons. Every other action is in
 * the "…" menu; the rest of the page (notes, care guide, tasks, history)
 * follows unchanged.
 */
export function PlantPageHeader({
  plant,
  location,
  myUserId,
  menu,
  onMenu,
  onDone,
  onClaim,
  onAddTask,
  isCompleting,
  snooze,
}: PlantPageHeaderProps) {
  const { t } = useTranslation();
  const active = (plant.status ?? 'active') === 'active';
  const [item] = plantCare([plant], active ? plant.upcomingTasks : []);
  const task = item.task;
  const due = task && item.days !== undefined && item.days <= 0;
  const status = active ? careStatusText(item, t) : null;
  const who = task ? careWho(task, myUserId) : null;
  const whoText =
    who?.kind === 'open'
      ? t('tasks.upForGrabs')
      : who?.kind === 'you'
        ? t('plants.list.you')
        : who?.kind === 'member'
          ? (who.name ?? t('plants.list.assigned'))
          : null;
  const last = task && plant.recentCompletions.find((c) => c.taskId === task.id);
  const taskName = task ? task.customType || t(`tasks.types.${task.type}`, task.type) : '';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="h-24 w-24 shrink-0 overflow-hidden rounded-2xl bg-parchment ring-1 ring-primary-100/60 large-text:h-16 large-text:w-16">
          <PlantImage plant={plant} width={96} height={96} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 large-text:flex-wrap">
            <h1 className="min-w-0 font-serif text-2xl leading-tight text-ink">{plant.name}</h1>
            {!active && <PlantStatusBadge status={plant.status!} />}
          </div>
          {plant.species && <p className="text-sm italic text-gray-600">{plant.species}</p>}
          <p className="text-sm text-gray-600">{location}</p>
        </div>
        {menu && (
          <ToolbarMenu
            label={t('plants.detail.more')}
            icon={<EllipsisHorizontalIcon className="h-6 w-6" aria-hidden="true" />}
            groups={menu}
            onSelect={onMenu}
          />
        )}
      </div>

      {active && (
        <section
          aria-label={t('plants.detail.statusLabel')}
          className={clsx(
            'rounded-2xl border p-4',
            item.days !== undefined && item.days < 0
              ? 'border-red-200 bg-red-50'
              : due
                ? 'border-accent-200 bg-accent-50'
                : 'border-primary-100 bg-paper'
          )}
        >
          <p
            className={clsx(
              'font-semibold',
              item.days !== undefined && item.days < 0
                ? 'text-red-800'
                : due
                  ? 'text-accent-800'
                  : 'text-ink'
            )}
          >
            {status}
          </p>
          {task && (
            <p className="mt-0.5 text-sm text-gray-700">
              {[
                whoText,
                last &&
                  t('plants.detail.lastBy', {
                    name: last.completedByName,
                    when: formatRelativeDay(last.completedAt),
                  }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          {task && due ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                className="grow"
                onClick={() => onDone(task)}
                disabled={isCompleting}
                leftIcon={<CheckIcon className="h-5 w-5" aria-hidden="true" />}
                aria-label={t('plants.detail.doAria', { task: taskName, plant: plant.name })}
              >
                {task.type === 'water' ? t('plants.detail.watered') : t('tasks.complete')}
              </Button>
              {who?.kind === 'open' && myUserId && (
                <Button variant="secondary" className="grow" onClick={() => onClaim(task)}>
                  {t('plants.detail.claim')}
                </Button>
              )}
              {snooze(task)}
            </div>
          ) : !task ? (
            <Button
              className="mt-3"
              variant="secondary"
              size="sm"
              onClick={onAddTask}
              leftIcon={<PlusIcon className="h-4 w-4" aria-hidden="true" />}
            >
              {t('tasks.addTask')}
            </Button>
          ) : null}
        </section>
      )}
    </div>
  );
}
