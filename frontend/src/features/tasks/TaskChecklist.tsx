import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { CheckIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/Button';
import { formatDate, formatRelativeDay } from '@/i18n/format';
import type { WhoText } from '@/features/plants/plantCareText';
import type { ChecklistItem, ChecklistSection, Segment } from './checklistModel';
import { TaskRow, type SwipeAction } from './TaskRow';

interface TaskChecklistProps {
  segment: Segment;
  onSegment: (segment: Segment) => void;
  counts: Record<Segment, number>;
  /** The page's own toolbar (the filter menu), beside the segments. */
  toolbar?: ReactNode;
  /** Removable filter tokens, under the segments. */
  tokens?: ReactNode;
  sections: ChecklistSection[];
  /** Heading of a room section (grouped by room). */
  roomTitle: (id: string) => string;
  /** The household has no tasks at all (not just none in this view). */
  householdEmpty: boolean;
  /** The first task after today, for "Next up" when Today is empty. */
  nextUp: ChecklistItem | null;
  taskName: (item: ChecklistItem) => string;
  roomOf: (item: ChecklistItem) => string | null;
  whoOf: (item: ChecklistItem) => WhoText;
  pending: ReadonlySet<string>;
  onCheck: (item: ChecklistItem) => void;
  onMenu: (item: ChecklistItem, from: Element | null) => void;
  registerCheck: (taskId: string, node: HTMLButtonElement | null) => void;
  extraFor: (item: ChecklistItem) => ReactNode;
  /** What a swipe to the left reveals on this row. */
  swipeActionsFor: (item: ChecklistItem) => SwipeAction[];
}

/**
 * The phone Tasks list ("Checklist"): the website under 640px and the iOS
 * app. A Today / Upcoming segment, then inset-grouped sections of one-line
 * task rows (TaskRow). The desktop website keeps its own layout.
 */
export function TaskChecklist({
  segment,
  onSegment,
  counts,
  toolbar,
  tokens,
  sections,
  roomTitle,
  householdEmpty,
  nextUp,
  taskName,
  roomOf,
  whoOf,
  pending,
  onCheck,
  onMenu,
  registerCheck,
  extraFor,
  swipeActionsFor,
}: TaskChecklistProps) {
  const { t } = useTranslation();

  const sectionTitle = (section: ChecklistSection) => {
    if (section.kind === 'overdue') return t('tasks.list.overdue');
    if (section.kind === 'today') return t('tasks.list.today');
    if (section.kind === 'room') return roomTitle(section.id);
    if (section.days === 1) return t('tasks.list.tomorrow');
    const day = formatDate(section.items[0].task.nextDue, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: undefined,
    });
    // A heading starts with a capital in every language ("Martes, 6 de
    // octubre"), though Spanish writes the weekday lowercase mid-sentence.
    return day.charAt(0).toLocaleUpperCase() + day.slice(1);
  };

  // Under a heading that already says the day, the row names the task only.
  const statusOf = (item: ChecklistItem, section: ChecklistSection) => {
    const name = taskName(item);
    if (pending.has(item.task.id)) return t('plants.list.marked', { task: name });
    if (section.kind === 'today' || section.kind === 'day') return name;
    if (item.days < 0) return t('plants.list.dueOverdue', { task: name, count: -item.days });
    if (item.days === 0) return t('plants.list.dueToday', { task: name });
    return t('plants.list.dueIn', { task: name, when: formatRelativeDay(item.task.nextDue) });
  };

  const segmentButton = (id: Segment, label: string) => (
    <button
      type="button"
      onClick={() => onSegment(id)}
      aria-pressed={segment === id}
      className={clsx(
        'inline-flex min-h-touch items-center justify-center gap-1.5 rounded-full px-3 text-sm font-semibold',
        segment === id ? 'bg-paper text-ink shadow-sm ring-1 ring-primary-100' : 'text-gray-700'
      )}
    >
      {label}
      {counts[id] > 0 && (
        <>
          {' '}
          <span className="font-medium text-gray-600">{counts[id]}</span>
        </>
      )}
    </button>
  );

  let body: ReactNode;
  if (householdEmpty) {
    body = (
      <div className="px-6 pt-10 text-center">
        <h2 className="text-xl font-semibold text-ink">{t('tasks.list.emptyTitle')}</h2>
        <p className="mt-2 text-gray-600">{t('tasks.list.emptyBody')}</p>
        <Link to="/plants/new" className="mt-5 inline-block">
          <Button>{t('plants.addPlant')}</Button>
        </Link>
      </div>
    );
  } else if (sections.length === 0) {
    body =
      segment === 'today' ? (
        <div className="px-6 pt-10 text-center">
          <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary-100 text-primary-700">
            <CheckIcon className="h-9 w-9" aria-hidden="true" />
          </span>
          <h2 className="mt-4 text-xl font-semibold text-ink">{t('tasks.list.allDoneTitle')}</h2>
          {nextUp && (
            <p className="mt-2 text-gray-600">
              {t('tasks.list.nextUp', {
                plant: nextUp.plantName,
                when: formatRelativeDay(nextUp.task.nextDue),
              })}
            </p>
          )}
        </div>
      ) : (
        <p className="px-6 pt-10 text-center text-gray-600">{t('tasks.list.upcomingEmpty')}</p>
      );
  } else {
    body = (
      <div className="space-y-5">
        {sections.map((section) => (
          <section key={section.id} aria-labelledby={`task-section-${section.id}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 px-1 pb-1.5">
              <h2
                id={`task-section-${section.id}`}
                className={clsx(
                  'text-lg font-semibold',
                  section.kind === 'overdue' ? 'text-red-700' : 'text-ink'
                )}
              >
                {sectionTitle(section)}
              </h2>
              <span className="text-sm text-gray-600">
                {t('tasks.list.count', { count: section.items.length })}
              </span>
            </div>
            <ul className="overflow-hidden rounded-2xl border border-primary-100/70 bg-paper divide-y divide-primary-100/60">
              {section.items.map((item) => {
                const name = taskName(item);
                return (
                  <TaskRow
                    key={item.task.id}
                    item={item}
                    status={statusOf(item, section)}
                    room={section.kind === 'room' ? null : roomOf(item)}
                    who={whoOf(item)}
                    pending={pending.has(item.task.id)}
                    doneLabel={t('plants.list.doAria', { task: name, plant: item.plantName })}
                    undoLabel={t('plants.list.undoAria', { task: name, plant: item.plantName })}
                    onCheck={() => onCheck(item)}
                    onMenu={(from) => onMenu(item, from)}
                    menuLabel={t('tasks.list.actions', { plant: item.plantName })}
                    registerCheck={(node) => registerCheck(item.task.id, node)}
                    extra={extraFor(item)}
                    doneText={name}
                    swipeActions={swipeActionsFor(item)}
                  />
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    );
  }

  return (
    <>
      {!householdEmpty && (
        <div className="flex items-center gap-2">
          <div
            role="group"
            aria-label={t('tasks.list.segments')}
            className="grid flex-1 grid-cols-2 gap-0.5 rounded-full bg-gray-500/10 p-0.5 large-text:grid-cols-1 large-text:rounded-3xl"
          >
            {segmentButton('today', t('tasks.list.today'))}
            {segmentButton('upcoming', t('tasks.list.upcoming'))}
          </div>
          {toolbar}
        </div>
      )}
      {tokens}
      {body}
    </>
  );
}
